import { Operator } from '../common/types/operator';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config/app.config';
import {
  Company,
  Consumption,
  Device,
  Employee,
  QrCode,
  Store,
  VerificationRule,
} from '../../database/entities';
import { BizException } from '../common/biz-code';
import { RedisService } from '../common/redis.service';
import { OperationLogService } from '../operation-log/operation-log.service';
import { evaluateRules, isInWindow, resolveWindow, toHhmm } from '../rule/rule-evaluator';
import { hashDeviceKey } from '../common/utils/device-key';
import { buildVerifyVoiceText, toMealStandard } from '../common/utils/meal-standard';
import { parseQrPayload } from '../qrcode/qr-encoder';

export interface VerifyResult {
  success: true;
  consumptionId: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  storeId: string | null;
  storeName: string | null;
  verifyTime: Date;
  remainQuota: number;
  /** 员工个人额度（公司分配）：null = 不限制 */
  employeeQuotaTotal: number | null;
  employeeQuotaUsed: number;
  /** null = 不限制 */
  employeeQuotaRemain: number | null;
  /** 公司餐标（元）；null = 未设置。仅用于展示，不参与扣减 */
  mealStandard: number | null;
  /**
   * 核销机器的语音播报文本，形如 `核销成功，餐标15元`。
   *
   * 为什么由服务端拼好而不是让机器自己拼：机器固件各式各样，
   * 让它去判断「有没有餐标、金额要不要去尾零」等于把业务规则复制到每台机器上。
   * 服务端给一句话，机器只管念。
   */
  voiceText: string;
  /** 命中的时段信息（公司配了规则才有） */
  window?: {
    name: string;
    text: string;
    limit: number;
    used: number;
    remain: number | null;
  } | null;
}

@Injectable()
export class VerifyService {
  private readonly logger = new Logger('VerifyService');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
    @InjectRepository(Employee) private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(QrCode) private readonly qrRepo: Repository<QrCode>,
    @InjectRepository(Device) private readonly deviceRepo: Repository<Device>,
    @InjectRepository(Store) private readonly storeRepo: Repository<Store>,
    @InjectRepository(Consumption) private readonly consumptionRepo: Repository<Consumption>,
    @InjectRepository(VerificationRule)     private readonly ruleRepo: Repository<VerificationRule>,
    private readonly redis: RedisService,
    private readonly logs: OperationLogService,
  ) {}

  // ---------------------------------------------------------------
  // 设备密钥
  // ---------------------------------------------------------------

  /** 与 DeviceService 共用同一套哈希算法，保证登记与核销口径一致 */
  static hashDeviceKey(plain: string): string {
    return hashDeviceKey(plain);
  }

  /**
   * 设备鉴权：返回设备记录。
   *
   * 优先用登记表下发的一机一密钥；旧的全局密钥仅在
   * ALLOW_LEGACY_DEVICE_TOKEN=1 时放行，生产必须关闭 ——
   * 否则「一把钥匙丢 = 全平台设备失守」。
   */
  async authenticateDevice(deviceKey?: string, deviceToken?: string, storeId?: string): Promise<Device | null> {
    if (deviceKey) {
      const hash = VerifyService.hashDeviceKey(deviceKey);
      const device = await this.deviceRepo.findOne({ where: { key_hash: hash } });
      if (!device) throw BizException.deviceInvalid('设备密钥无效或已失效');
      if (device.status !== 1) throw BizException.deviceInvalid('设备已停用，请联系平台管理员');
      return device;
    }

    if (deviceToken) {
      const legacy = process.env.DEVICE_TOKEN || 'legacy-device-token';
      if (!this.config.allowLegacyDeviceToken) {
        throw BizException.deviceInvalid(
          '旧的全局设备密钥通道已关闭，请升级为设备登记密钥',
        );
      }
      if (deviceToken !== legacy) {
        throw BizException.deviceInvalid('设备密钥无效');
      }
      return null; // 旧通道无设备绑定，storeId 由请求传入
    }

    throw BizException.deviceInvalid('缺少设备密钥');
  }

  // ---------------------------------------------------------------
  // 核销主链路
  // ---------------------------------------------------------------

  /**
   * 核销核心链路（设计文档 4.2，顺序即此处代码顺序）：
   *
   *   a. 校验二维码 token 有效、未过期、未使用
   *   b. 校验员工 status 正常、公司 status 正常
   *   c. 校验核销时段与时段内次数  ← **必须在扣减之前**
   *   d. 校验公司 remain_quota > 0
   *   e. 原子扣减次数
   *   f. 写入 consumptions 记录（含归属的 rule_id）
   *   g. 返回核销成功 + 剩余次数 + 命中时段信息
   *
   * c 步放在 d/e 之前是硬要求：不满足时段条件的请求
   * **一次次数都不能扣**，否则用户被拒却掉了额度，无法解释。
   */
  async verify(params: {
    qrToken: string;
    /** 设备核销时传入已鉴权的设备；员工端代扫时为 null */
    device?: Device | null;
    /** 请求传入的门店（设备绑店时会被忽略） */
    storeId?: string | null;
    /** 核销员 id：员工代扫时为员工 id；设备核销为 null */
    verifierId?: string | null;
    /** 操作日志用的操作人信息 */
    operator?: Operator;
    ip?: string | null;
  }): Promise<VerifyResult> {
    const { qrToken: rawQrToken, device, storeId, verifierId, operator, ip } = params;

    // ── 0. 归一化扫码内容
    // 二维码里画的是 `TCV1:<token>`（前缀帮扫码端识别这是我们的码），
    // 但库里存的是裸 token。parseQrPayload 负责剥前缀、兼容裸 token ——
    // 之前它"只定义未调用"，所有扫码端都会收到莫名的 2001，就在这里补上。
    // 兼做 trim：截图/手动输码场景常带首尾空白。
    const qrToken = parseQrPayload(rawQrToken);

    // ── a. 二维码校验（**只读校验，此处不占位**）
    // 占位放在所有业务校验通过之后：若提前占位，员工在非用餐时段
    // 误扫一次，二维码就作废了，必须手动刷新才能再扫 —— 这是个体验硬伤。
    const qr: QrCode = await this.peekQrToken(qrToken);

    // ── b. 员工 / 公司状态
    const employee = await this.employeeRepo.findOne({ where: { id: qr.employee_id } });
    if (!employee) throw BizException.qrInvalid('二维码对应的员工不存在');
    if (employee.status !== 1) {
      throw BizException.accountDisabled('该员工账号已停用，无法核销');
    }

    const company = await this.companyRepo.findOne({ where: { id: qr.company_id } });
    if (!company) throw BizException.notFound('公司不存在');
    if (company.status !== 1) {
      throw BizException.accountDisabled('所属公司已停用，无法核销');
    }

    // ── 门店落点：设备绑定门店优先，忽略请求参数
    const finalStoreId = await this.resolveStoreId(device, storeId);

    // ── c. 核销时段校验（在扣减之前！）
    const now = new Date();
    const rules = await this.ruleRepo.find({
      where: { company_id: String(company.id), status: 1 },
      order: { id: 'ASC' },
    });

    const evaluation = await this.evaluateWithCount(rules, String(employee.id), now);
    if (!evaluation.allowed) {
      // 拒绝时不做任何扣减 —— 校验位置决定了这一点
      await this.logs.record({
        companyId: String(company.id),
        module: 'verify',
        action: 'verify_reject',
        description: `核销被拒：${evaluation.reason}`,
        operatorId: operator?.uid ?? null,
        operatorName: operator?.name ?? employee.name,
        operatorRole: operator?.role ?? 'employee',
        targetType: 'employee',
        targetId: employee.id,
        detail: { reason: evaluation.reason, qrToken: qrToken.slice(0, 8) + '...' },
        ip,
      });
      throw BizException.outOfWindow(evaluation.reason);
    }

    // ── c2. 员工个人额度只读预检
    // 提前拦一道，让"次数已用完"的请求连占位都不产生 —— 用户刷新二维码后
    // 依旧能再扫（二维码没被消耗），体验上不会有"白扫一次"的挫败感。
    // 真正的防超扣仍以下面 e2 的原子 UPDATE 为准，这里只是快速失败。
    if (employee.quota_total !== null && employee.quota_total !== undefined) {
      const usedNow = Number(employee.quota_used) || 0;
      if (usedNow >= Number(employee.quota_total)) {
        await this.logs.record({
          companyId: String(company.id),
          module: 'verify',
          action: 'verify_reject',
          description: `核销被拒：员工个人核销次数已用完（${usedNow}/${employee.quota_total}）`,
          operatorId: operator?.uid ?? null,
          operatorName: operator?.name ?? employee.name,
          operatorRole: operator?.role ?? 'employee',
          targetType: 'employee',
          targetId: employee.id,
          detail: { reason: 'employee_quota_exhausted', used: usedNow, total: employee.quota_total },
          ip,
        });
        throw BizException.employeeQuotaExhausted();
      }
    }

    // ── 原子占位（防重复核销）
    // 放在这里而不是链路开头：前面所有校验都"不动数据"，
    // 被拒时不消耗二维码，用户刷新或稍后重试即可。
    // 从这里开始才是真正的"提交"阶段。
    const claimed = await this.redis.setNx(
      `verify:${qrToken}`,
      Math.max(this.config.qrcodeTtlSeconds, 60),
    );
    if (!claimed) throw BizException.duplicateVerify();

    // ── d + e. 原子扣减（乐观锁 SQL，防超扣）
    const deductResult = await this.companyRepo
      .createQueryBuilder()
      .update(Company)
      .set({ remain_quota: () => 'remain_quota - 1' })
      .where('id = :id AND remain_quota > 0', { id: company.id })
      .execute();

    if (!deductResult.affected || deductResult.affected === 0) {
      // 次数不足同样要释放占位：这二维码没用掉，员工充值后还能继续扫
      await this.redis.del(`verify:${qrToken}`);
      throw BizException.quotaExhausted('该公司剩余次数不足，请联系平台管理员充值');
    }

    // ── e2. 员工个人额度原子扣减（第二道闸）
    // 条件里带 `quota_total IS NULL OR quota_used < quota_total`，
    // 让"额度判断"和"扣减"在一条 SQL 里完成，避免并发下先查后扣的竞态。
    // 员工无个人额度（NULL）时 SQL 恒真，直接 +1，不影响老租户。
    const empDeduct = await this.employeeRepo
      .createQueryBuilder()
      .update(Employee)
      .set({ quota_used: () => 'quota_used + 1' })
      .where('id = :eid AND (quota_total IS NULL OR quota_used < quota_total)', {
        eid: employee.id,
      })
      .execute();

    if (!empDeduct.affected || empDeduct.affected === 0) {
      // 员工额度不足：公司池刚才已经扣了，必须原样补回来 + 释放占位，
      // 否则会出现"被拒一次，公司总次数少 1"的账目黑洞。
      await this.companyRepo
        .createQueryBuilder()
        .update(Company)
        .set({ remain_quota: () => 'remain_quota + 1' })
        .where('id = :id', { id: company.id })
        .execute();
      await this.releaseClaim(qrToken);
      await this.logs.record({
        companyId: String(company.id),
        module: 'verify',
        action: 'verify_reject',
        description: `核销被拒：员工个人核销次数已用完（并发占用）`,
        operatorId: operator?.uid ?? null,
        operatorName: operator?.name ?? employee.name,
        operatorRole: operator?.role ?? 'employee',
        targetType: 'employee',
        targetId: employee.id,
        detail: { reason: 'employee_quota_exhausted', atomic: true },
        ip,
      });
      throw BizException.employeeQuotaExhausted();
    }

    // ── f. 写核销记录
    let consumption: Consumption;
    try {
      consumption = await this.consumptionRepo.save(
        this.consumptionRepo.create({
          company_id: String(company.id),
          employee_id: String(employee.id),
          qrcode_id: String(qr.id),
          store_id: finalStoreId,
          verify_time: now,
          deduct_quota: 1,
          verifier_id: verifierId ? String(verifierId) : null,
          rule_id: evaluation.matchedRuleId,
        }),
      );
    } catch (e) {
      // 记录写失败必须把扣减补回来，否则次数凭空蒸发
      await this.companyRepo
        .createQueryBuilder()
        .update(Company)
        .set({ remain_quota: () => 'remain_quota + 1' })
        .where('id = :id', { id: company.id })
        .execute();
      // 员工个人额度同样要回补（e2 已经扣过）
      await this.employeeRepo
        .createQueryBuilder()
        .update(Employee)
        .set({ quota_used: () => 'quota_used - 1' })
        .where('id = :eid AND quota_used > 0', { eid: employee.id })
        .execute();
      // 同时释放占位，让用户可以重试
      await this.releaseClaim(qrToken);
      this.logger.error(`核销记录写入失败，已回补次数：${(e as Error).message}`);
      throw BizException.badRequest('核销记录写入失败，请重试');
    }

    // 二维码置为「已核销」（status=2，区别于刷新/停用产生的 0=作废）+
    // 设备使用时间。员工端轮询看到 2，就能在占位区显示「已核销（套餐档）」，
    // 而不是继续挂着一张已经没用的码。
    await this.qrRepo.update({ id: qr.id }, { status: 2 });
    if (device) {
      await this.deviceRepo.update({ id: device.id }, { last_used_at: now });
    }

    const store = finalStoreId
      ? await this.storeRepo.findOne({ where: { id: finalStoreId } })
      : null;

    const freshCompany = await this.companyRepo.findOne({ where: { id: company.id } });
    const freshEmployee = await this.employeeRepo.findOne({ where: { id: employee.id } });
    const empQuotaTotal =
      freshEmployee?.quota_total === null || freshEmployee?.quota_total === undefined
        ? null
        : Number(freshEmployee.quota_total);
    const empQuotaUsed = Number(freshEmployee?.quota_used) || 0;

    // 餐标与播报文案：餐标是公司级配置，核销过程中不会被改，直接用入口处读到的值
    const mealStandard = toMealStandard(company.meal_standard);

    // 拿不到就不给吗？不 —— 核销已经成功了，回传窗口信息只是增强体验
    const window = evaluation.matchedRuleId
      ? {
          name: evaluation.windowName,
          text: evaluation.windowText,
          limit: evaluation.limit ?? 0,
          used: (evaluation.used ?? 0) + 1,
          remain: evaluation.remain ?? null,
        }
      : null;

    await this.logs.record({
      companyId: String(company.id),
      module: 'verify',
      action: 'verify',
      description: `核销成功：${employee.name}${store ? ` @ ${store.name}` : ''}`,
      operatorId: operator?.uid ?? null,
      operatorName: operator?.name ?? employee.name,
      operatorRole: operator?.role ?? 'employee',
      targetType: 'employee',
      targetId: employee.id,
      detail: {
        consumptionId: String(consumption.id),
        storeId: finalStoreId,
        storeName: store?.name ?? null,
        remaining: freshCompany?.remain_quota ?? null,
        ruleId: evaluation.matchedRuleId,
        window: window?.text ?? null,
      },
      ip,
    });

    return {
      success: true,
      consumptionId: String(consumption.id),
      employeeId: String(employee.id),
      employeeName: employee.name,
      companyId: String(company.id),
      storeId: finalStoreId,
      storeName: store?.name ?? null,
      verifyTime: now,
      remainQuota: freshCompany?.remain_quota ?? 0,
      employeeQuotaTotal: empQuotaTotal,
      employeeQuotaUsed: empQuotaUsed,
      employeeQuotaRemain: empQuotaTotal === null ? null : Math.max(0, empQuotaTotal - empQuotaUsed),
      mealStandard,
      voiceText: buildVerifyVoiceText(mealStandard),
      window,
    };
  }

  /**
   * 二维码只读校验（不做占位）
   *
   * 与「占位」分离是刻意的：校验可能因时段、次数、公司停用等各种理由失败，
   * 而这些失败都不该消耗用户的二维码。占位推迟到提交阶段，
   * 失败时用 releaseClaim 释放。
   */
  private async peekQrToken(token: string): Promise<QrCode> {
    const qr = await this.qrRepo.findOne({ where: { token } });
    if (!qr) throw BizException.qrInvalid('二维码无效，请刷新后重试');
    if (qr.status !== 1) throw BizException.qrInvalid('二维码已使用，请刷新后重试');
    if (qr.expire_at && new Date(qr.expire_at).getTime() < Date.now()) {
      throw BizException.qrInvalid('二维码已过期，请刷新后重试');
    }
    return qr;
  }

  /** 释放占位：仅在占位后、落库前发生可恢复失败时调用 */
  private async releaseClaim(token: string) {
    try {
      await this.redis.del(`verify:${token}`);
    } catch (e) {
      this.logger.warn(`释放二维码占位失败（已忽略）：${(e as Error).message}`);
    }
  }

  /**
   * 门店落点判定。
   *
   * 设备已绑定门店时以设备为准 —— 否则一台 A 店设备改一下请求参数
   * 就能冒充 B 店核销，门店统计会失真。
   */
  private async resolveStoreId(device: Device | null, reqStoreId?: string | null): Promise<string | null> {
    if (device?.store_id) return String(device.store_id);

    if (reqStoreId) {
      const store = await this.storeRepo.findOne({ where: { id: reqStoreId } });
      if (!store) throw BizException.badRequest('门店不存在');
      if (store.status !== 1) throw BizException.badRequest('门店已停用');
      return String(store.id);
    }
    return null;
  }

  /**
   * 统计「该员工在某条规则的本时段内已核销几次」，再交给 evaluateRules 裁决。
   *
   * 实现上先按当前时刻筛出命中规则（这一步不查库），只为命中的规则
   * 各查一次 COUNT —— 避免为一条都用不上的规则白跑查询。
   */
  private async evaluateWithCount(rules: VerificationRule[], employeeId: string, now: Date) {
    if (!rules || rules.length === 0) {
      return evaluateRules(rules, now, () => 0);
    }

    const hhmm = toHhmm(now);
    const candidates = rules.filter((r) => isInWindow(hhmm, r.start_time, r.end_time));

    const counts = new Map<string, number>();
    for (const r of candidates) {
      const w = resolveWindow(r, now);
      // 口径 = rule_id + 员工 + 时段区间。三个条件缺一不可：
      // rule_id 保证规则不追溯既往；时段区间保证跨天的次数不累积到第二天。
      const n = await this.consumptionRepo
        .createQueryBuilder('c')
        .where('c.company_id = :cid', { cid: String(r.company_id) })
        .andWhere('c.employee_id = :eid', { eid: employeeId })
        .andWhere('c.rule_id = :rid', { rid: String(r.id) })
        .andWhere('c.verify_time >= :start', { start: w.windowStart })
        .andWhere('c.verify_time <= :end', { end: w.windowEnd })
        .getCount();
      counts.set(String(r.id), n);
    }

    return evaluateRules(rules, now, (ruleId) => counts.get(ruleId) ?? 0);
  }
}
