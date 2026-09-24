import { Operator } from '../common/types/operator';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Company, VerificationRule } from '../../database/entities';
import { BizException } from '../common/biz-code';
import { OperationLogService } from '../operation-log/operation-log.service';
import { isInWindow, toHhmm } from './rule-evaluator';

export interface RuleDto {
  name: string;
  startTime: string;
  endTime: string;
  perEmployeeLimit?: number;
  status?: number;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

@Injectable()
export class RuleService {
  constructor(
    @InjectRepository(VerificationRule) private readonly ruleRepo: Repository<VerificationRule>,
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
    private readonly logs: OperationLogService,
  ) {}

  async listByCompany(companyId: string) {
    const rules = await this.ruleRepo.find({
      where: { company_id: companyId },
      order: { id: 'ASC' },
    });
    const hhmm = toHhmm(new Date());
    return rules.map((r) => ({
      id: String(r.id),
      companyId: String(r.company_id),
      name: r.name,
      startTime: r.start_time,
      endTime: r.end_time,
      perEmployeeLimit: r.per_employee_limit,
      crossDay: r.start_time > r.end_time,
      active: r.status === 1 && isInWindow(hhmm, r.start_time, r.end_time),
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  /**
   * 只取**启用中**的时段规则，供「出码准入」这类只需判"在不在时段"的场景用。
   *
   * 与 listByCompany 的区别：不带 active/status 等展示字段，
   * 也不返回停用规则 —— 停用规则不该参与任何准入判断。
   */
  async listEnabledByCompany(companyId: string) {
    const rules = await this.ruleRepo.find({
      where: { company_id: companyId, status: 1 },
      order: { id: 'ASC' },
    });
    return rules.map((r) => ({
      id: String(r.id),
      name: r.name,
      startTime: r.start_time,
      endTime: r.end_time,
      perEmployeeLimit: r.per_employee_limit,
      crossDay: r.start_time > r.end_time,
    }));
  }

  async findOne(id: string) {
    const rule = await this.ruleRepo.findOne({ where: { id } });
    if (!rule) throw BizException.notFound('时段规则不存在');
    return rule;
  }

  async create(
    companyId: string,
    dto: RuleDto,
    operator: Operator,
    ip?: string | null,
  ) {
    this.validate(dto);

    const company = await this.companyRepo.findOne({ where: { id: companyId } });
    if (!company) throw BizException.badRequest('公司不存在');

    const rule = await this.ruleRepo.save(
      this.ruleRepo.create({
        company_id: companyId,
        name: dto.name.trim(),
        start_time: dto.startTime,
        end_time: dto.endTime,
        per_employee_limit: this.normalizeLimit(dto.perEmployeeLimit),
        status: dto.status !== undefined ? (Number(dto.status) === 1 ? 1 : 0) : 1,
      }),
    );

    await this.logs.record({
      companyId,
      module: 'rule',
      action: 'create',
      description: `新增核销时段「${rule.name}」${rule.start_time}-${rule.end_time}，每人${
        rule.per_employee_limit === 0 ? '不限' : rule.per_employee_limit + ' 次'
      }`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'rule',
      targetId: rule.id,
      detail: {
        name: rule.name,
        startTime: rule.start_time,
        endTime: rule.end_time,
        perEmployeeLimit: rule.per_employee_limit,
        crossDay: rule.start_time > rule.end_time,
      },
      ip,
    });

    return { id: String(rule.id) };
  }

  async update(
    id: string,
    dto: Partial<RuleDto>,
    scope: { companyId: string | null; isSuper: boolean },
    operator: Operator,
    ip?: string | null,
  ) {
    const rule = await this.findOne(id);
    // 跨租户拦截：非超管只能改本公司规则
    if (!scope.isSuper && String(rule.company_id) !== String(scope.companyId)) {
      throw BizException.forbidden('无权操作其他公司的时段规则');
    }

    const merged = {
      name: dto.name ?? rule.name,
      startTime: dto.startTime ?? rule.start_time,
      endTime: dto.endTime ?? rule.end_time,
      perEmployeeLimit:
        dto.perEmployeeLimit !== undefined ? dto.perEmployeeLimit : rule.per_employee_limit,
    };
    this.validate(merged);

    const before = {
      name: rule.name,
      startTime: rule.start_time,
      endTime: rule.end_time,
      perEmployeeLimit: rule.per_employee_limit,
      status: rule.status,
    };

    rule.name = merged.name.trim();
    rule.start_time = merged.startTime;
    rule.end_time = merged.endTime;
    rule.per_employee_limit = this.normalizeLimit(merged.perEmployeeLimit);
    if (dto.status !== undefined) rule.status = Number(dto.status) === 1 ? 1 : 0;

    await this.ruleRepo.save(rule);

    await this.logs.record({
      companyId: String(rule.company_id),
      module: 'rule',
      action: 'update',
      description: `编辑核销时段「${rule.name}」`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'rule',
      targetId: rule.id,
      detail: {
        before,
        after: {
          name: rule.name,
          startTime: rule.start_time,
          endTime: rule.end_time,
          perEmployeeLimit: rule.per_employee_limit,
          status: rule.status,
        },
      },
      ip,
    });

    return { id: String(rule.id) };
  }

  async setStatus(
    id: string,
    status: number,
    scope: { companyId: string | null; isSuper: boolean },
    operator: Operator,
    ip?: string | null,
  ) {
    const rule = await this.findOne(id);
    if (!scope.isSuper && String(rule.company_id) !== String(scope.companyId)) {
      throw BizException.forbidden('无权操作其他公司的时段规则');
    }

    const before = rule.status;
    rule.status = Number(status) === 1 ? 1 : 0;
    await this.ruleRepo.save(rule);

    await this.logs.record({
      companyId: String(rule.company_id),
      module: 'rule',
      action: 'status',
      description: `${rule.status === 1 ? '启用' : '停用'}核销时段「${rule.name}」`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'rule',
      targetId: rule.id,
      detail: { before: { status: before }, after: { status: rule.status } },
      ip,
    });

    return { id: String(rule.id), status: rule.status };
  }

  /**
   * 删除时段规则。
   *
   * 删除后该时段不再限制核销；历史 consumptions 里保留的 rule_id
   * 会变成指向不存在的规则 —— 这是可接受的：统计口径按 rule_id 归属，
   * 规则没了等于该口径作废，但已经产生的核销记录本身不该被抹掉。
   */
  async remove(
    id: string,
    scope: { companyId: string | null; isSuper: boolean },
    operator: Operator,
    ip?: string | null,
  ) {
    const rule = await this.findOne(id);
    if (!scope.isSuper && String(rule.company_id) !== String(scope.companyId)) {
      throw BizException.forbidden('无权操作其他公司的时段规则');
    }

    const snapshot = {
      name: rule.name,
      startTime: rule.start_time,
      endTime: rule.end_time,
      perEmployeeLimit: rule.per_employee_limit,
    };
    await this.ruleRepo.delete({ id: rule.id });

    await this.logs.record({
      companyId: String(rule.company_id),
      module: 'rule',
      action: 'delete',
      description: `删除核销时段「${rule.name}」，该时段不再限制核销`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'rule',
      targetId: rule.id,
      detail: { deleted: snapshot },
      ip,
    });

    return { id: String(rule.id) };
  }

  private validate(dto: { name: string; startTime: string; endTime: string }) {
    if (!dto.name || !String(dto.name).trim()) {
      throw BizException.badRequest('时段名称不能为空');
    }
    if (String(dto.name).trim().length > 50) {
      throw BizException.badRequest('时段名称不能超过 50 个字符');
    }
    if (!HHMM.test(dto.startTime || '')) {
      throw BizException.badRequest('开始时间格式应为 HH:mm（如 11:00）');
    }
    if (!HHMM.test(dto.endTime || '')) {
      throw BizException.badRequest('结束时间格式应为 HH:mm（如 13:30）');
    }
    if (dto.startTime === dto.endTime) {
      throw BizException.badRequest('开始时间与结束时间不能相同');
    }
  }

  /** 次数：0 = 不限；负数无意义，统一收敛为 0 */
  private normalizeLimit(v: unknown): number {
    if (v === undefined || v === null || v === '') return 1;
    const n = Number(v);
    if (Number.isNaN(n)) throw BizException.badRequest('每人次数必须是数字');
    if (n < 0) throw BizException.badRequest('每人次数不能为负数');
    if (n > 99) throw BizException.badRequest('每人次数不能超过 99');
    return Math.floor(n);
  }
}
