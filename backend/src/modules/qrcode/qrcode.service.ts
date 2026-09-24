import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { APP_CONFIG, AppConfig } from '../../config/app.config';
import {
  Consumption,
  Employee,
  QrCode,
  VerificationRule,
} from '../../database/entities';
import { BizException } from '../common/biz-code';
import { RedisService } from '../common/redis.service';
import { RuleService } from '../rule/rule.service';
import { isInWindow, toHhmm } from '../rule/rule-evaluator';
import { QrEncoder, buildQrPayload, toSvgDataUrl } from './qr-encoder';

@Injectable()
export class QrcodeService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectRepository(QrCode) private readonly qrRepo: Repository<QrCode>,
    @InjectRepository(Employee) private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(Consumption) private readonly consumptionRepo: Repository<Consumption>,
    @InjectRepository(VerificationRule) private readonly ruleRepo: Repository<VerificationRule>,
    private readonly redis: RedisService,
    private readonly rules: RuleService,
  ) {}

  /**
   * 时段准入校验：不在可核销时段就抛业务异常，拒绝发码。
   *
   * 语义与核销链路（rule-evaluator.evaluateRules）保持一致：
   * - 公司**一条启用规则都没有** → 不限制，放行（老租户升级后行为不变）
   * - 有规则但当前时刻不落在任何一条里 → 拒绝，并在 message 里列出全部时段
   *
   * 只判「是否在时段内」，不判「本时段次数是否用完」——
   * 次数是核销时才知道的结果，提前拦会让用户看到"码都不给"却不知为何。
   * 次数不足的提示交给核销页。
   */
  private async assertInWindow(companyId: string) {
    const rules = await this.rules.listEnabledByCompany(companyId);
    if (rules.length === 0) return; // 无规则 = 不限制

    const hhmm = toHhmm(new Date());
    const hit = rules.some((r) => isInWindow(hhmm, r.startTime, r.endTime));
    if (hit) return;

    const available = rules
      .map((r) => `${r.name} ${r.startTime}-${r.endTime}`)
      .join('、');
    throw BizException.outOfWindow(`当前不在可核销时段，可核销时间：${available}`);
  }

  /**
   * 生成 / 刷新当前员工的动态二维码。
   *
   * 动态码特性：
   * - 5 分钟有效（qrcodeTtlSeconds 可配）
   * - 一次性：核销时用 Redis SETNX 占位，成功后即失效
   *
   * 刷新时把该员工之前的动态码置为失效，避免小程序反复刷新
   * 在库里堆出一堆仍可用的活码。
   *
   * 时段准入：不在公司配置的可核销时段内**直接拒绝发码**。
   * 为什么要在出码这一步拦，而不是等核销时再拦 ——
   * 前者用户拿到的是「明确告知不能核销」，后者是饿着肚子排到窗口才被拒。
   * 核销时的判定依然保留（客户端时间可篡改，服务端那道防线不能撤）。
   */
  async issue(employeeId: string, companyId: string) {
    const employee = await this.employeeRepo.findOne({ where: { id: employeeId } });
    if (!employee) throw BizException.notFound('员工不存在');
    if (employee.status !== 1) throw BizException.accountDisabled('账号已停用，请联系公司管理员');

    // 个人额度用尽同样不发码 —— 与「不在时段不发码」同一思路：
    // 前端明确告知，别让员工端着手机排到窗口才被拒。
    // 注意这里也**不能**因为额度不足就跳过；核销时仍会再校一次（服务端权威）。
    const quotaTotal =
      employee.quota_total === null || employee.quota_total === undefined
        ? null
        : Number(employee.quota_total);
    const quotaUsed = Number(employee.quota_used) || 0;
    if (quotaTotal !== null && quotaUsed >= quotaTotal) {
      throw BizException.employeeQuotaExhausted();
    }

    await this.assertInWindow(companyId);

    // 让该员工旧的动态码失效
    await this.qrRepo.update(
      { employee_id: employeeId, type: 2, status: 1 },
      { status: 0 },
    );

    const token = randomBytes(24).toString('hex'); // 48 位
    const ttl = this.config.qrcodeTtlSeconds;
    const expireAt = new Date(Date.now() + ttl * 1000);

    const qr = this.qrRepo.create({
      company_id: companyId,
      employee_id: employeeId,
      type: 2,
      token,
      status: 1,
      expire_at: expireAt,
    });
    await this.qrRepo.save(qr);

    /**
     * 真的把二维码画出来，而不是只回一个 token 让前端自己想办法。
     *
     * 用 SVG data URL 而不是 PNG：本地零依赖模式（LOCAL_MODE=1）下
     * 没有 sharp/canvas 这类原生模块，SVG 是字符串拼接，任何环境都跑得动，
     * 小程序 `<image>` 也直接认。
     */
    const qrImageUrl = toSvgDataUrl(QrEncoder.encode(buildQrPayload(token)));

    return {
      qrToken: token,
      qrImageUrl,
      qrcodeId: String(qr.id),
      expireAt,
      ttlSeconds: ttl,
      // 本人剩余次数：小程序在二维码下方直显，用前最直观
      quotaTotal,
      quotaUsed,
      quotaRemain: quotaTotal === null ? null : Math.max(0, quotaTotal - quotaUsed),
    };
  }

  /**
   * 校验并消费二维码（原子）。
   *
   * 两道防线：
   * 1. Redis SETNX verify:{token} —— 拦截「同一 token 并发提交」；
   * 2. 库里 status/expire_at 复核 —— 拦截 token 被手工复用。
   *
   * 占位成功但后续步骤失败时**不释放占位** —— 二维码本就是一次性的，
   * 释放反而给了重放窗口；让用户刷新拿新的即可。
   */
  async consumeToken(token: string): Promise<QrCode> {
    const qr = await this.qrRepo.findOne({ where: { token } });
    if (!qr) throw BizException.qrInvalid('二维码无效，请刷新后重试');
    if (qr.status !== 1) throw BizException.qrInvalid('二维码已使用，请刷新后重试');
    if (qr.expire_at && new Date(qr.expire_at).getTime() < Date.now()) {
      throw BizException.qrInvalid('二维码已过期，请刷新后重试');
    }

    // 原子占位：TTL 覆盖二维码剩余有效期即可（用配置 TTL 兜底）
    const ttl = Math.max(this.config.qrcodeTtlSeconds, 60);
    const ok = await this.redis.setNx(`verify:${token}`, ttl);
    if (!ok) throw BizException.duplicateVerify();

    return qr;
  }

  /**
   * 核销成功后落库置「已核销」。
   *
   * 是 2 不是 0：0 是刷新换码/停用/解绑产生的「作废」，
   * 2 是「这张码真的完成了一次核销」——员工端靠这个值
   * 把占位区切换成「已核销（套餐档）」。两条核销链路
   * （verify.service 直写 / 本方法）必须保持同一语义。
   */
  async markUsed(qrId: string) {
    await this.qrRepo.update({ id: qrId }, { status: 2 });
  }

  /**
   * 当前员工最近一张动态码的状态 —— 给小程序轮询用。
   *
   * 员工出示二维码后被核销，员工自己是最晚知道的人：
   * 码还挂在屏幕上，扫没扫成只能看核销员的表情。
   * 这个接口让员工端每 2 秒问一次，一旦最近一张码变成「已核销」，
   * 占位区立即切到「已核销（套餐档）」。
   *
   * 返回三种 state：
   * - active   : 有有效码（含剩余秒数，可校对本地倒计时）
   * - consumed : 最近一张码已核销（带时段名/核销时间）
   * - none     : 没有码，或最近一张只是被刷新/作废（状态 0）——
   *              这是日常轮询的正常背景，员工端无需为此做任何事
   */
  async getStatus(employeeId: string) {
    const qr = await this.qrRepo.findOne({
      where: { employee_id: employeeId, type: 2 },
      order: { id: 'DESC' },
    });
    if (!qr) return { state: 'none' as const };

    if (qr.status === 1) {
      const remain = qr.expire_at
        ? Math.max(0, Math.round((new Date(qr.expire_at).getTime() - Date.now()) / 1000))
        : 0;
      return { state: 'active' as const, remainSeconds: remain };
    }

    if (qr.status === 2) {
      // 核销记录按 qrcode_id 反查时段名（套餐档）。查不到记录不拦——
      // 状态本身已确凿，时段名只是展示增强。
      const consumption = await this.consumptionRepo.findOne({
        where: { qrcode_id: String(qr.id) },
        order: { id: 'DESC' },
      });
      let windowName: string | null = null;
      if (consumption?.rule_id) {
        const rule = await this.ruleRepo.findOne({
          where: { id: String(consumption.rule_id) },
        });
        windowName = rule?.name ?? null;
      }
      return {
        state: 'consumed' as const,
        windowName,
        verifyTime: consumption?.verify_time ?? null,
      };
    }

    return { state: 'none' as const };
  }

  /** 清理过期二维码（可由定时任务调用） */
  async purgeExpired() {
    const res = await this.qrRepo.update(
      { type: 2, status: 1, expire_at: LessThan(new Date()) },
      { status: 0 },
    );
    return res.affected || 0;
  }
}
