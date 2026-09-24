import { Operator } from '../common/types/operator';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Like, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config/app.config';
import { Company, Consumption, Employee, Plan, Store } from '../../database/entities';
import { BizException } from '../common/biz-code';
import { OperationLogService } from '../operation-log/operation-log.service';
import {
  MEAL_STANDARD_MAX,
  MEAL_STANDARD_TIERS,
  normalizeMealStandard,
  mealStandardText,
  toMealStandard,
} from '../common/utils/meal-standard';

export interface PageQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
}

@Injectable()
export class CompanyService {
  constructor(
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
    @InjectRepository(Employee) private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(Consumption) private readonly consumptionRepo: Repository<Consumption>,
    @InjectRepository(Plan) private readonly planRepo: Repository<Plan>,
    @InjectRepository(Store) private readonly storeRepo: Repository<Store>,
    private readonly logs: OperationLogService,
  ) {}

  /** 公司列表：平台端全量数组（前端下拉、公司管理页直接用） */
  async listAll() {
    const companies = await this.companyRepo.find({ order: { id: 'ASC' } });
    const planIds = [...new Set(companies.map((c) => c.plan_id).filter(Boolean))] as string[];
    const plans = planIds.length
      ? await this.planRepo.find({ where: { id: In(planIds) } })
      : [];
    const planMap = new Map(plans.map((p) => [String(p.id), p]));

    // 员工数批量统计，避免 N+1
    const counts = await this.employeeRepo
      .createQueryBuilder('e')
      .select('e.company_id', 'companyId')
      .addSelect('COUNT(*)', 'cnt')
      .groupBy('e.company_id')
      .getRawMany();
    const countMap = new Map(counts.map((c) => [String(c.companyId), Number(c.cnt)]));

    return companies.map((c) => ({
      id: String(c.id),
      name: c.name,
      contactName: c.contact_name,
      contactPhone: c.contact_phone,
      planId: c.plan_id ? String(c.plan_id) : null,
      planName: c.plan_id ? planMap.get(String(c.plan_id))?.name ?? null : null,
      totalQuota: c.total_quota,
      remainQuota: c.remain_quota,
      usedQuota: Math.max(0, c.total_quota - c.remain_quota),
      mealStandard: toMealStandard(c.meal_standard),
      employeeCount: countMap.get(String(c.id)) ?? 0,
      status: c.status,
      createdAt: c.created_at,
    }));
  }

  async listPaged(q: PageQuery) {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
    const qb = this.companyRepo.createQueryBuilder('c').orderBy('c.id', 'DESC');
    if (q.keyword) qb.andWhere('c.name LIKE :kw', { kw: `%${q.keyword}%` });
    const [rows, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    return { total, page, pageSize, list: rows };
  }

  async findOne(id: string) {
    const c = await this.companyRepo.findOne({ where: { id } });
    if (!c) throw BizException.notFound('公司不存在');
    return c;
  }

  // ---------------------------------------------------------------
  // 公司设置（当前只有餐标一项，后续公司级配置都往这儿放）
  // ---------------------------------------------------------------

  /** 公司端读取自己的设置（**只读**）：餐标 + 可选档位（档位由后端下发，前端不硬编码） */
  async getSettings(companyId: string) {
    const company = await this.findOne(companyId);
    return {
      companyId: String(company.id),
      companyName: company.name,
      mealStandard: toMealStandard(company.meal_standard),
      mealStandardText: mealStandardText(company.meal_standard),
      tiers: [...MEAL_STANDARD_TIERS],
      maxStandard: MEAL_STANDARD_MAX,
    };
  }

  /**
   * 设置公司餐标 —— **只由平台端调用**（PUT /api/platform/companies/:id/meal-standard）。
   *
   * 权限在控制器上：那个控制器类级就是 @Roles('super')，公司角色进不来。
   * 服务层不再重复做 scope 判断，因为除了平台端没有第二个调用方
   * —— 加一层永远为真的校验只会让人误以为这里有租户隔离。
   *
   * 语义区分（很重要，别混）：
   * - `null`   → 清除餐标，核销播报只说「核销成功」
   * - `数字`   → 设为该餐标，播报「核销成功，餐标 N 元」
   * - `0`      → 视同清除（0 元没有业务含义，播报成「餐标0元」只会更怪）
   */
  async setMealStandard(
    companyId: string,
    value: number | null,
    operator: Operator,
    ip?: string | null,
  ) {
    const company = await this.findOne(companyId);
    const before = toMealStandard(company.meal_standard);
    const next = normalizeMealStandard(value);

    company.meal_standard = next === null ? null : next.toFixed(2);
    await this.companyRepo.save(company);

    await this.logs.record({
      companyId: String(company.id),
      module: 'company',
      action: 'meal-standard',
      description:
        next === null
          ? `清除公司「${company.name}」餐标（原 ${before ?? '—'} 元）`
          : `设置公司「${company.name}」餐标为 ${next} 元（原 ${before ?? '—'} 元）`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'company',
      targetId: company.id,
      detail: { before, after: next },
      ip,
    });

    return {
      companyId: String(company.id),
      mealStandard: next,
      mealStandardText: mealStandardText(company.meal_standard),
    };
  }

  /** 平台端统计看板 / 全局对账 */
  async platformStatistics() {
    const totalCompanies = await this.companyRepo.count();
    const activeCompanies = await this.companyRepo.count({ where: { status: 1 } });
    const totalEmployees = await this.employeeRepo.count();
    const activeEmployees = await this.employeeRepo.count({ where: { status: 1 } });
    const totalConsumptions = await this.consumptionRepo.count();

    const quotaAgg = await this.companyRepo
      .createQueryBuilder('c')
      .select('COALESCE(SUM(c.total_quota), 0)', 'total')
      .addSelect('COALESCE(SUM(c.remain_quota), 0)', 'remain')
      .getRawOne();

    const todayConsumptions = await this.consumptionRepo
      .createQueryBuilder('c')
      .where('c.verify_time >= :s', { s: this.startOfToday() })
      .getCount();

    return {
      totalCompanies,
      activeCompanies,
      totalEmployees,
      activeEmployees,
      totalConsumptions,
      todayConsumptions,
      totalQuota: Number(quotaAgg?.total ?? 0),
      remainQuota: Number(quotaAgg?.remain ?? 0),
      usedQuota: Number(quotaAgg?.total ?? 0) - Number(quotaAgg?.remain ?? 0),
    };
  }

  /** 公司端统计看板 */
  async companyStatistics(companyId: string) {
    const company = await this.findOne(companyId);

    const employeeCount = await this.employeeRepo.count({ where: { company_id: companyId } });
    const activeEmployeeCount = await this.employeeRepo.count({
      where: { company_id: companyId, status: 1 },
    });
    const totalConsumptions = await this.consumptionRepo.count({
      where: { company_id: companyId },
    });
    const todayConsumptions = await this.consumptionRepo
      .createQueryBuilder('c')
      .where('c.company_id = :cid', { cid: companyId })
      .andWhere('c.verify_time >= :s', { s: this.startOfToday() })
      .getCount();

    return {
      companyId: String(company.id),
      companyName: company.name,
      totalQuota: company.total_quota,
      remainQuota: company.remain_quota,
      usedQuota: Math.max(0, company.total_quota - company.remain_quota),
      employeeCount,
      activeEmployeeCount,
      totalConsumptions,
      todayConsumptions,
    };
  }

  async create(
    dto: {
      name: string;
      contactName?: string;
      contactPhone?: string;
      planId?: string;
      totalQuota?: number;
      status?: number;
      mealStandard?: number | null;
    },
    operator: Operator,
    ip?: string | null,
  ) {
    if (!dto.name?.trim()) throw BizException.badRequest('公司名称不能为空');

    const totalQuota = Number(dto.totalQuota ?? 0);
    if (totalQuota < 0) throw BizException.badRequest('次数不能为负数');

    // 套餐带出配额：前端传了 planId 但没传 totalQuota 时按套餐填
    let plan: Plan | null = null;
    if (dto.planId) {
      plan = await this.planRepo.findOne({ where: { id: dto.planId } });
      if (!plan) throw BizException.badRequest('套餐不存在');
    }

    const mealStandard = normalizeMealStandard(dto.mealStandard);

    const company = await this.companyRepo.save(
      this.companyRepo.create({
        name: dto.name.trim(),
        contact_name: dto.contactName ?? null,
        contact_phone: dto.contactPhone ?? null,
        plan_id: dto.planId ?? null,
        total_quota: dto.totalQuota !== undefined ? totalQuota : plan?.quota ?? 0,
        remain_quota: dto.totalQuota !== undefined ? totalQuota : plan?.quota ?? 0,
        meal_standard: mealStandard === null ? null : mealStandard.toFixed(2),
        status: dto.status ?? 1,
      }),
    );

    await this.logs.record({
      companyId: null,
      module: 'company',
      action: 'create',
      description:
        `新增公司「${company.name}」，配额 ${company.total_quota} 次` +
        (mealStandard === null ? '' : `，餐标 ${mealStandard} 元`),
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'company',
      targetId: company.id,
      detail: {
        name: company.name,
        totalQuota: company.total_quota,
        planId: dto.planId ?? null,
        mealStandard,
      },
      ip,
    });

    return { id: String(company.id) };
  }

  /**
   * 编辑公司 / 启停 / 充值。
   *
   * 「充值」识别：totalQuota 变大时 action 记为 recharge 而非 update，
   * 让运营扫一眼日志就能找到「何时给某公司充了几次」。
   *
   * **不含餐标**：改餐标走 setMealStandard（PUT companies/:id/meal-standard），
   * 单独一条 action，排查时不必在 update 的 detail 里翻。
   */
  async update(
    id: string,
    dto: {
      name?: string;
      contactName?: string;
      contactPhone?: string;
      planId?: string;
      totalQuota?: number;
      remainQuota?: number;
      status?: number;
    },
    operator: Operator,
    ip?: string | null,
  ) {
    const company = await this.findOne(id);
    const before = {
      name: company.name,
      totalQuota: company.total_quota,
      remainQuota: company.remain_quota,
      status: company.status,
      planId: company.plan_id,
    };

    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw BizException.badRequest('公司名称不能为空');
      company.name = dto.name.trim();
    }
    if (dto.contactName !== undefined) company.contact_name = dto.contactName || null;
    if (dto.contactPhone !== undefined) company.contact_phone = dto.contactPhone || null;
    if (dto.planId !== undefined) company.plan_id = dto.planId || null;
    if (dto.status !== undefined) company.status = Number(dto.status) === 1 ? 1 : 0;

    let isRecharge = false;
    let rechargeDelta = 0;

    if (dto.totalQuota !== undefined) {
      const next = Number(dto.totalQuota);
      if (next < 0) throw BizException.badRequest('次数不能为负数');
      if (next < company.total_quota) {
        // 缩容时剩余次数不能超过总量，否则会出现「剩余 > 总量」的脏数据
        const consumed = company.total_quota - company.remain_quota;
        if (consumed > next) {
          throw BizException.badRequest(
            `已核销 ${consumed} 次，总量不能小于已核销次数`,
          );
        }
      }
      if (next > company.total_quota) {
        isRecharge = true;
        rechargeDelta = next - company.total_quota;
      }
      // 充值差额同步加到剩余次数
      company.remain_quota = Math.max(0, company.remain_quota + (next - company.total_quota));
      company.total_quota = next;
    }

    // 允许直接校正剩余次数（人工对账用），但不允许超过总量
    if (dto.remainQuota !== undefined) {
      const rq = Number(dto.remainQuota);
      if (rq < 0) throw BizException.badRequest('剩余次数不能为负数');
      if (rq > company.total_quota) {
        throw BizException.badRequest('剩余次数不能大于总次数');
      }
      company.remain_quota = rq;
    }

    await this.companyRepo.save(company);

    const after = {
      name: company.name,
      totalQuota: company.total_quota,
      remainQuota: company.remain_quota,
      status: company.status,
      planId: company.plan_id,
    };

    await this.logs.record({
      companyId: String(company.id),
      module: 'company',
      action: isRecharge ? 'recharge' : 'update',
      description: isRecharge
        ? `为「${company.name}」充值 ${rechargeDelta} 次（总量 ${before.totalQuota} → ${after.totalQuota}）`
        : dto.status !== undefined && before.status !== after.status
          ? `${after.status === 1 ? '启用' : '停用'}公司「${company.name}」`
          : `编辑公司「${company.name}」`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'company',
      targetId: company.id,
      detail: { before, after },
      ip,
    });

    return { id: String(company.id) };
  }

  private startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
}
