import { Operator } from '../common/types/operator';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Company, Consumption, Employee, QrCode, Store, VerificationRule } from '../../database/entities';
import { BizException } from '../common/biz-code';
import { OperationLogService } from '../operation-log/operation-log.service';
import { isInWindow, toHhmm } from '../rule/rule-evaluator';
import { mealStandardText, toMealStandard } from '../common/utils/meal-standard';

@Injectable()
export class EmployeeService {
  constructor(
    @InjectRepository(Employee) private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
    @InjectRepository(Consumption) private readonly consumptionRepo: Repository<Consumption>,
    @InjectRepository(QrCode) private readonly qrRepo: Repository<QrCode>,
    @InjectRepository(Store) private readonly storeRepo: Repository<Store>,
    @InjectRepository(VerificationRule) private readonly ruleRepo: Repository<VerificationRule>,
    private readonly logs: OperationLogService,
  ) {}

  // ---------------------------------------------------------------
  // 员工端：我的信息
  // ---------------------------------------------------------------

  async me(employeeId: string) {
    const employee = await this.employeeRepo.findOne({ where: { id: employeeId } });
    if (!employee) throw BizException.notFound('员工不存在');
    const company = await this.companyRepo.findOne({ where: { id: employee.company_id } });

    const myConsumptions = await this.consumptionRepo.count({
      where: { employee_id: employeeId },
    });
    const todayConsumptions = await this.consumptionRepo
      .createQueryBuilder('c')
      .where('c.employee_id = :eid', { eid: employeeId })
      .andWhere('c.verify_time >= :s', { s: this.startOfToday() })
      .getCount();

    // 今日可核销时段：用于首页「当前可核销 / 当前未开放」提示 + 「今日还可 N 次」
    const windows = await this.todayWindows(String(employee.company_id), employeeId);

    return {
      id: String(employee.id),
      name: employee.name,
      phone: this.maskPhone(employee.phone),
      employeeNo: employee.employee_no,
      status: employee.status,
      companyId: String(employee.company_id),
      companyName: company?.name ?? null,
      mealStandard: toMealStandard(company?.meal_standard),
      mealStandardText: mealStandardText(company?.meal_standard),
      myConsumptions,
      todayConsumptions,
      windows,
      // 本人剩余核销次数（null = 公司未设限制）
      ...this.quotaVo(employee),
    };
  }

  /** 单查本人额度 —— 供 windows 等轻量接口拼装，避免为了拿额度去跑整套 me() */
  /**
   * 本人剩余额度 + 公司餐标。
   *
   * 合成一个方法是因为调用方（核销页）两样都要，拆开会让同一次渲染
   * 查两遍员工、两遍公司。餐标额外给一份 `mealStandardText`
   * （"15 元" / "未设置"），省得小程序自己拼字符串再处理 null。
   */
  async myQuota(employeeId: string) {
    const employee = await this.employeeRepo.findOne({ where: { id: employeeId } });
    if (!employee) throw BizException.notFound('员工不存在');
    const company = await this.companyRepo.findOne({ where: { id: employee.company_id } });
    return {
      ...this.quotaVo(employee),
      mealStandard: toMealStandard(company?.meal_standard),
      mealStandardText: mealStandardText(company?.meal_standard),
    };
  }

  /**
   * 本公司今日可核销时段 + 当前是否开放。
   *
   * 注意：这只是给用户看的提示，**拦截始终以服务端核销时为准** ——
   * 客户端时间可被篡改，不能作为准入依据。
   */
  /**
   * 本公司今日可核销时段。
   *
   * 传入 employeeId 时，额外算出「该员工今天在这个时段已经核销几次、还能几次」——
   * 首页要展示「今日还可 N 次」。不传则不算，省一次查询
   * （核销时的准入判断只需要时段本身，跟个人已用次数无关）。
   */
  async todayWindows(companyId: string, employeeId?: string | null) {
    const rules = await this.ruleRepo.find({
      where: { company_id: companyId, status: 1 },
      order: { id: 'ASC' },
    });
    const hhmm = toHhmm(new Date());

    // 一次分组查询拿到今天各规则下的核销数，避免按规则循环查（N+1）
    const usedMap = new Map<string, number>();
    if (employeeId && rules.length) {
      const rows = await this.consumptionRepo
        .createQueryBuilder('c')
        .select('c.rule_id', 'ruleId')
        .addSelect('COUNT(*)', 'cnt')
        .where('c.employee_id = :eid', { eid: employeeId })
        .andWhere('c.verify_time >= :s', { s: this.startOfToday() })
        .andWhere('c.rule_id IS NOT NULL')
        .groupBy('c.rule_id')
        .getRawMany();
      for (const r of rows) {
        usedMap.set(String(r.ruleId), Number(r.cnt) || 0);
      }
    }

    return rules.map((r) => {
      const limit = r.per_employee_limit;
      const usedToday = usedMap.get(String(r.id)) ?? 0;
      return {
        id: String(r.id),
        name: r.name,
        startTime: r.start_time,
        endTime: r.end_time,
        limit,
        crossDay: r.start_time > r.end_time,
        active: isInWindow(hhmm, r.start_time, r.end_time),
        usedToday,
        // limit = 0 表示该时段不限次；否则剩余不能为负
        remainToday: limit === 0 ? null : Math.max(0, limit - usedToday),
      };
    });
  }

  /** 当前是否处于任一可核销时段；无规则时为 true（不限制） */
  async isOpenNow(companyId: string, employeeId?: string | null) {
    const windows = await this.todayWindows(companyId, employeeId);
    if (windows.length === 0) return { open: true, windows, currentTime: toHhmm(new Date()) };
    return {
      open: windows.some((w) => w.active),
      windows,
      currentTime: toHhmm(new Date()),
    };
  }

  // ---------------------------------------------------------------
  // 我的消费记录
  // ---------------------------------------------------------------

  async myConsumptions(employeeId: string, page = 1, pageSize = 20) {
    const p = Math.max(1, Number(page) || 1);
    const ps = Math.min(100, Math.max(1, Number(pageSize) || 20));

    const [rows, total] = await this.consumptionRepo.findAndCount({
      where: { employee_id: employeeId },
      order: { verify_time: 'DESC' },
      skip: (p - 1) * ps,
      take: ps,
    });

    const storeIds = [...new Set(rows.map((r) => r.store_id).filter(Boolean))] as string[];
    const stores = storeIds.length
      ? await this.storeRepo.find({ where: { id: In(storeIds) } })
      : [];
    const storeMap = new Map(stores.map((s) => [String(s.id), s.name]));

    return {
      total,
      page: p,
      pageSize: ps,
      list: rows.map((r) => ({
        id: String(r.id),
        verifyTime: r.verify_time,
        storeId: r.store_id ? String(r.store_id) : null,
        storeName: r.store_id ? storeMap.get(String(r.store_id)) ?? null : null,
        deductQuota: r.deduct_quota,
      })),
    };
  }

  async myStatistics(employeeId: string) {
    const total = await this.consumptionRepo.count({ where: { employee_id: employeeId } });
    const today = await this.consumptionRepo
      .createQueryBuilder('c')
      .where('c.employee_id = :eid', { eid: employeeId })
      .andWhere('c.verify_time >= :s', { s: this.startOfToday() })
      .getCount();
    const month = await this.consumptionRepo
      .createQueryBuilder('c')
      .where('c.employee_id = :eid', { eid: employeeId })
      .andWhere('c.verify_time >= :s', { s: this.startOfMonth() })
      .getCount();
    return { total, today, month };
  }

  // ---------------------------------------------------------------
  // 公司端：员工列表 + 停用/启用（唯一可写操作）
  // ---------------------------------------------------------------

  async listByCompany(
    companyId: string,
    q: { page?: number; pageSize?: number; keyword?: string; status?: number },
  ) {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));

    const qb = this.employeeRepo
      .createQueryBuilder('e')
      .where('e.company_id = :cid', { cid: companyId })
      .orderBy('e.id', 'DESC');

    if (q.keyword) {
      qb.andWhere('(e.name LIKE :kw OR e.phone LIKE :kw OR e.employee_no LIKE :kw)', {
        kw: `%${q.keyword}%`,
      });
    }
    if (q.status !== undefined && q.status !== null && String(q.status) !== '') {
      qb.andWhere('e.status = :st', { st: Number(q.status) });
    }

    const [rows, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();

    // 每个员工的核销次数：一次聚合查询搞定，避免 N+1
    const ids = rows.map((r) => String(r.id));
    const countMap = new Map<string, number>();
    if (ids.length) {
      const agg = await this.consumptionRepo
        .createQueryBuilder('c')
        .select('c.employee_id', 'employeeId')
        .addSelect('COUNT(*)', 'cnt')
        .where('c.employee_id IN (:...ids)', { ids })
        .groupBy('c.employee_id')
        .getRawMany();
      for (const a of agg) countMap.set(String(a.employeeId), Number(a.cnt));
    }

    return {
      total,
      page,
      pageSize,
      list: rows.map((e) => ({
        id: String(e.id),
        companyId: String(e.company_id),
        name: e.name,
        phone: e.phone,
        employeeNo: e.employee_no,
        status: e.status,
        bound: !!e.openid,
        consumptionCount: countMap.get(String(e.id)) ?? 0,
        createdAt: e.created_at,
        ...this.quotaVo(e),
      })),
    };
  }

  /**
   * 停用 / 启用员工 —— 公司端唯一的写操作。
   *
   * 停用语义：逻辑删除。停用后禁止核销、二维码失效，
   * 但历史核销记录保留，便于统计对账。
   */
  async setStatus(
    id: string,
    status: number,
    scope: { companyId: string | null; isSuper: boolean },
    operator: Operator,
    ip?: string | null,
  ) {
    const employee = await this.employeeRepo.findOne({ where: { id } });
    if (!employee) throw BizException.notFound('员工不存在');

    // 租户拦截：非超管只能动本公司的员工
    if (!scope.isSuper && String(employee.company_id) !== String(scope.companyId)) {
      throw BizException.forbidden('无权操作其他公司的员工');
    }

    const next = Number(status) === 1 ? 1 : 0;
    const before = employee.status;
    employee.status = next;
    await this.employeeRepo.save(employee);

    // 停用时让该员工所有有效二维码立即失效，避免停用后还能扫
    if (next === 0) {
      await this.qrRepo.update({ employee_id: id, status: 1 }, { status: 0 });
    }

    await this.logs.record({
      companyId: String(employee.company_id),
      module: 'employee',
      action: 'status',
      description: `${next === 1 ? '启用' : '停用'}员工「${employee.name}」`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'employee',
      targetId: employee.id,
      detail: { before: { status: before }, after: { status: next } },
      ip,
    });

    return { id: String(employee.id), status: next };
  }

  // ---------------------------------------------------------------
  // 员工额度：公司分配给个人的核销次数
  // ---------------------------------------------------------------

  /**
   * 设置单个员工的核销次数。
   *
   * quotaTotal 语义：`null` = 不限制；`0` = 一次都不允许；正数 = 具体次数。
   *
   * **不追溯历史**：员工已用 5 次时把额度设成 3，剩余直接算成 0，
   * 不会去"压缩"已用量 —— 否则 consumption 历史与计数就对不上了。
   * 想重新发一轮额度用 `resetUsed`（把已用计数清零）。
   */
  async setQuota(
    id: string,
    quotaTotal: number | null | undefined,
    opts: { resetUsed?: boolean },
    scope: { companyId: string | null; isSuper: boolean },
    operator: Operator,
    ip?: string | null,
  ) {
    const employee = await this.employeeRepo.findOne({ where: { id } });
    if (!employee) throw BizException.notFound('员工不存在');

    // 租户拦截：非超管只能动本公司的员工
    if (!scope.isSuper && String(employee.company_id) !== String(scope.companyId)) {
      throw BizException.forbidden('无权操作其他公司的员工');
    }

    const next = this.normalizeQuota(quotaTotal);
    const before = this.quotaVo(employee);

    employee.quota_total = next;
    if (opts.resetUsed) employee.quota_used = 0;
    await this.employeeRepo.save(employee);

    const after = this.quotaVo(employee);

    await this.logs.record({
      companyId: String(employee.company_id),
      module: 'employee',
      action: 'quota',
      description:
        `设置员工「${employee.name}」核销次数为 ${next === null ? '不限' : `${next} 次`}` +
        (opts.resetUsed ? '（已用次数已清零）' : ''),
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'employee',
      targetId: employee.id,
      detail: { before, after, resetUsed: !!opts.resetUsed },
      ip,
    });

    return { id: String(employee.id), name: employee.name, ...after };
  }

  /**
   * 批量设置员工核销次数。
   *
   * 传进来的 id 里只要混了别家公司的，**整批拒绝并指明是谁** ——
   * 静默跳过会让管理员以为都设好了，等到员工核销被拒才发现漏了。
   */
  async batchSetQuota(
    employeeIds: string[],
    quotaTotal: number | null | undefined,
    scope: { companyId: string | null; isSuper: boolean },
    operator: Operator,
    ip?: string | null,
  ) {
    const ids = [...new Set((employeeIds || []).map((x) => String(x).trim()).filter(Boolean))];
    if (ids.length === 0) throw BizException.badRequest('请至少选择一名员工');
    if (ids.length > 500) throw BizException.badRequest('单次最多设置 500 人');

    const next = this.normalizeQuota(quotaTotal);

    const employees = await this.employeeRepo.find({ where: { id: In(ids) } });
    const found = new Set(employees.map((e) => String(e.id)));

    const missing = ids.filter((x) => !found.has(x));
    if (missing.length) throw BizException.notFound(`以下员工不存在：${missing.join('、')}`);

    if (!scope.isSuper) {
      const foreign = employees.filter((e) => String(e.company_id) !== String(scope.companyId));
      if (foreign.length) {
        throw BizException.forbidden(
          `无权操作其他公司的员工：${foreign.map((e) => e.name).join('、')}`,
        );
      }
    }

    for (const e of employees) e.quota_total = next;
    await this.employeeRepo.save(employees);

    await this.logs.record({
      companyId: scope.companyId ?? String(employees[0].company_id),
      module: 'employee',
      action: 'quota_batch',
      description: `批量设置 ${employees.length} 名员工的核销次数为 ${next === null ? '不限' : `${next} 次`}`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'employee',
      detail: {
        count: employees.length,
        quotaTotal: next,
        employees: employees.map((e) => ({ id: String(e.id), name: e.name })),
      },
      ip,
    });

    return {
      count: employees.length,
      quotaTotal: next,
      list: employees.map((e) => ({ id: String(e.id), name: e.name, ...this.quotaVo(e) })),
    };
  }

  /** 额度对外结构：`null` 一律表示"不限制"，前端只需判空 */
  private quotaVo(e: { quota_total?: number | null; quota_used?: number | null }) {
    const raw = e.quota_total;
    const total = raw === null || raw === undefined ? null : Number(raw);
    const used = Number(e.quota_used) || 0;
    return {
      quotaTotal: total,
      quotaUsed: used,
      /** null = 不限制 */
      quotaRemain: total === null ? null : Math.max(0, total - used),
    };
  }

  /**
   * 额度合法性：null = 不限；否则必须是 0 ~ 100000 的整数。
   *
   * 这里再校验一次是刻意的：DTO 只覆盖 HTTP 入口，
   * 内部调用（如批量导入按公司默认额度初始化）绕过 DTO 时仍要守住。
   */
  private normalizeQuota(v: number | null | undefined): number | null {
    if (v === null) return null;
    if (v === undefined) {
      throw BizException.badRequest('缺少 quotaTotal（传 null 表示不限制）');
    }
    const n = Number(v);
    if (!Number.isInteger(n)) throw BizException.badRequest('核销次数必须是整数');
    if (n < 0) throw BizException.badRequest('核销次数不能为负数');
    if (n > 100000) throw BizException.badRequest('核销次数不能超过 100000');
    return n;
  }

  // ---------------------------------------------------------------
  // 微信绑定：解绑
  // ---------------------------------------------------------------

  /**
   * 解绑员工微信。
   *
   * 解决的死锁：员工换微信后，新微信登录必定被
   * 「该员工账号已绑定其他微信，请联系公司管理员」拦住，
   * 而在本接口之前管理员**没有任何办法**解除旧绑定 —— 只能找平台改库。
   *
   * 三件事一起做，缺一不可：
   * 1. `openid` 置 NULL（唯一索引允许多个 NULL，所以别人不受影响）
   * 2. `token_version` +1 —— 否则员工手机上的旧 token 还能一直用到过期，
   *    管理员会看到列表写着「未绑定」、员工却照样能出码
   * 3. 作废该员工所有有效二维码 —— 二维码是设备端直接兑换的凭证，
   *    不依赖员工 token，只清会话的话，之前截图存下来的码还能继续用
   *
   * 解绑**不等于停用**：额度、核销记录、账号状态一概不动，
   * 重新登录绑定后一切照旧。要禁止某人核销请用停用。
   */
  async unbindWechat(
    id: string,
    scope: { companyId: string | null; isSuper: boolean },
    operator: Operator,
    ip?: string | null,
  ) {
    const employee = await this.employeeRepo.findOne({ where: { id } });
    if (!employee) throw BizException.notFound('员工不存在');

    // 租户拦截：非超管只能动本公司的员工
    if (!scope.isSuper && String(employee.company_id) !== String(scope.companyId)) {
      throw BizException.forbidden('无权操作其他公司的员工');
    }

    // 未绑定时报错而不是静默成功：后台按钮本来就只在已绑定时可点，
    // 真走到这里多半是并发了或看错了人，返回 200 会让管理员以为清掉了。
    if (!employee.openid) {
      throw BizException.badRequest(`员工「${employee.name}」尚未绑定微信`);
    }

    const beforeTv = employee.token_version ?? 1;
    employee.openid = null;
    employee.token_version = beforeTv + 1;
    await this.employeeRepo.save(employee);

    // 二维码是设备端直接兑换的凭证，不看员工 token，必须一并作废
    const killedQr = await this.qrRepo.update({ employee_id: id, status: 1 }, { status: 0 });

    await this.logs.record({
      companyId: String(employee.company_id),
      module: 'employee',
      action: 'unbind_wechat',
      description: `解绑员工「${employee.name}」的微信`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'employee',
      targetId: employee.id,
      // 刻意不记 openid：它是该员工在微信侧的唯一标识，属于个人信息，
      // 解绑后留着没有任何业务价值（重绑会拿到新的），
      // 记进日志只会让平台侧能横向看到别人的微信标识。
      detail: {
        before: { bound: true, tokenVersion: beforeTv },
        after: { bound: false, tokenVersion: employee.token_version },
        voidedQrCodes: killedQr?.affected ?? 0,
      },
      ip,
    });

    return {
      id: String(employee.id),
      name: employee.name,
      bound: false,
      voidedQrCodes: killedQr?.affected ?? 0,
    };
  }

  // ---------------------------------------------------------------
  // 平台端：员工增删改 + 批量导入
  // ---------------------------------------------------------------

  async listAll(
    q: { page?: number; pageSize?: number; keyword?: string; companyId?: string; status?: number },
  ) {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));

    const qb = this.employeeRepo.createQueryBuilder('e').orderBy('e.id', 'DESC');
    if (q.companyId) qb.andWhere('e.company_id = :cid', { cid: q.companyId });
    if (q.keyword) {
      qb.andWhere('(e.name LIKE :kw OR e.phone LIKE :kw OR e.employee_no LIKE :kw)', {
        kw: `%${q.keyword}%`,
      });
    }
    if (q.status !== undefined && q.status !== null && String(q.status) !== '') {
      qb.andWhere('e.status = :st', { st: Number(q.status) });
    }

    const [rows, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();

    const companyIds = [...new Set(rows.map((r) => String(r.company_id)))];
    const companies = companyIds.length
      ? await this.companyRepo.find({ where: companyIds.map((id) => ({ id })) })
      : [];
    const companyMap = new Map(companies.map((c) => [String(c.id), c.name]));

    return {
      total,
      page,
      pageSize,
      list: rows.map((e) => ({
        id: String(e.id),
        companyId: String(e.company_id),
        companyName: companyMap.get(String(e.company_id)) ?? null,
        name: e.name,
        phone: e.phone,
        employeeNo: e.employee_no,
        status: e.status,
        bound: !!e.openid,
        createdAt: e.created_at,
        ...this.quotaVo(e),
      })),
    };
  }

  async create(
    dto: {
      companyId: string;
      name: string;
      phone: string;
      employeeNo?: string;
      status?: number;
    },
    operator: Operator,
    ip?: string | null,
  ) {
    await this.assertCreatable(dto.companyId, dto.name, dto.phone, dto.employeeNo);

    const employee = await this.employeeRepo.save(
      this.employeeRepo.create({
        company_id: dto.companyId,
        name: dto.name.trim(),
        phone: dto.phone.trim(),
        employee_no: dto.employeeNo?.trim() || null,
        status: dto.status ?? 1,
      }),
    );

    await this.logs.record({
      companyId: dto.companyId,
      module: 'employee',
      action: 'create',
      description: `新增员工「${employee.name}」`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'employee',
      targetId: employee.id,
      detail: { name: employee.name, phone: employee.phone, employeeNo: employee.employee_no },
      ip,
    });

    return { id: String(employee.id) };
  }

  /**
   * 批量导入：**逐行校验，个别行失败不回滚整批**。
   *
   * 运营拿到一张 500 人的表，不能因为第 3 行手机号重复就整批退回 ——
   * 那等于让人回去手工挑 3 小时。所以这里逐行 try，
   * 成功的入库、失败的进 skipped 明细，最后一并回报。
   */
  async batchImport(
    rows: Array<{ companyId: string; name: string; phone: string; employeeNo?: string }>,
    operator: Operator,
    ip?: string | null,
  ) {
    const success: Array<{ row: number; id: string; name: string }> = [];
    const skipped: Array<{ row: number; name: string; phone: string; reason: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowNo = i + 1;
      try {
        await this.assertCreatable(r.companyId, r.name, r.phone, r.employeeNo);
        const employee = await this.employeeRepo.save(
          this.employeeRepo.create({
            company_id: r.companyId,
            name: String(r.name).trim(),
            phone: String(r.phone).trim(),
            employee_no: r.employeeNo?.trim() || null,
            status: 1,
          }),
        );
        success.push({ row: rowNo, id: String(employee.id), name: employee.name });
      } catch (e) {
        skipped.push({
          row: rowNo,
          name: r.name,
          phone: r.phone,
          reason: e instanceof Error ? e.message : '导入失败',
        });
      }
    }

    await this.logs.record({
      companyId: rows[0]?.companyId ?? null,
      module: 'employee',
      action: 'batch_import',
      description: `批量导入员工：成功 ${success.length} 人，跳过 ${skipped.length} 人`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'employee',
      detail: { total: rows.length, success: success.length, skipped: skipped.length },
      ip,
    });

    return { total: rows.length, successCount: success.length, skippedCount: skipped.length, success, skipped };
  }

  async update(
    id: string,
    dto: {
      name?: string;
      phone?: string;
      employeeNo?: string;
      companyId?: string;
      status?: number;
      quotaTotal?: number | null;
    },
    operator: Operator,
    ip?: string | null,
  ) {
    const employee = await this.employeeRepo.findOne({ where: { id } });
    if (!employee) throw BizException.notFound('员工不存在');

    const before = {
      name: employee.name,
      phone: employee.phone,
      employeeNo: employee.employee_no,
      companyId: String(employee.company_id),
      status: employee.status,
      ...this.quotaVo(employee),
    };

    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw BizException.badRequest('姓名不能为空');
      employee.name = dto.name.trim();
    }
    if (dto.phone !== undefined) {
      const phone = dto.phone.trim();
      if (!/^1[3-9]\d{9}$/.test(phone)) throw BizException.badRequest('手机号格式不正确');
      // 一人一号：手机号唯一
      const dup = await this.employeeRepo.findOne({ where: { phone } });
      if (dup && String(dup.id) !== String(id)) {
        throw BizException.badRequest(`手机号 ${phone} 已被其他员工占用`);
      }
      employee.phone = phone;
    }
    if (dto.employeeNo !== undefined) employee.employee_no = dto.employeeNo?.trim() || null;

    // ── 跨公司转移：必须同时失效会话与未使用的二维码
    //
    // 员工 JWT 里内嵌了 companyId，且 JwtAuthGuard 只对 admin 角色
    // 从库里重新推导公司，**员工不重新推导**。因此转移公司后，
    // 旧令牌仍携带旧租户 id —— 它会被 QrcodeService.issue() 当作
    // 二维码的 company_id 写库，后续核销按旧公司扣额度，
    // 形成跨租户配额消耗（CWE-613 租户作用域残留）。
    //
    // 同文件里的 unbindWechat / setStatus 都会主动失效，
    // 转移公司却漏了 —— 这里补齐，保持行为一致。
    let companyChanged = false;
    if (dto.companyId !== undefined && String(dto.companyId) !== String(employee.company_id)) {
      const company = await this.companyRepo.findOne({ where: { id: dto.companyId } });
      if (!company) throw BizException.badRequest('公司不存在');
      employee.company_id = dto.companyId;
      companyChanged = true;
    }

    if (dto.status !== undefined) {
      employee.status = Number(dto.status) === 1 ? 1 : 0;
      if (employee.status === 0) {
        await this.qrRepo.update({ employee_id: id, status: 1 }, { status: 0 });
      }
    }
    // 额度：null = 不限制。不追溯已用量（想重发额度请用专用接口 resetUsed）
    if (dto.quotaTotal !== undefined) {
      employee.quota_total = this.normalizeQuota(dto.quotaTotal);
    }

    // 转移公司 → 递增 token_version 让旧租户范围的 JWT 立即失效
    if (companyChanged) {
      employee.token_version = (employee.token_version ?? 1) + 1;
    }

    await this.employeeRepo.save(employee);

    // 转移公司 → 作废该员工所有未使用的二维码。
    // 二维码是设备端可直接兑换的凭证，不依赖员工令牌，
    // 仅递增 token_version 挡不住它 —— 必须显式作废。
    if (companyChanged) {
      await this.qrRepo.update({ employee_id: id, status: 1 }, { status: 0 });
    }

    await this.logs.record({
      companyId: String(employee.company_id),
      module: 'employee',
      action: 'update',
      description: companyChanged
        ? `将员工「${employee.name}」转移至其他公司（已失效其登录状态与未使用二维码）`
        : `编辑员工「${employee.name}」`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'employee',
      targetId: employee.id,
      detail: {
        before,
        after: {
          name: employee.name,
          phone: employee.phone,
          employeeNo: employee.employee_no,
          companyId: String(employee.company_id),
          status: employee.status,
          ...this.quotaVo(employee),
        },
        ...(companyChanged ? { companyTransferred: true } : {}),
      },
      ip,
    });

    return { id: String(employee.id) };
  }

  /** 行级校验：公司存在、姓名/手机号合规、不重复 */
  private async assertCreatable(
    companyId: string,
    name: string,
    phone: string,
    employeeNo?: string,
  ) {
    if (!companyId) throw BizException.badRequest('缺少所属公司');
    if (!name || !String(name).trim()) throw BizException.badRequest('姓名不能为空');

    const p = String(phone || '').trim();
    if (!p) throw BizException.badRequest('手机号不能为空');
    if (!/^1[3-9]\d{9}$/.test(p)) throw BizException.badRequest(`手机号 ${p} 格式不正确`);

    const company = await this.companyRepo.findOne({ where: { id: companyId } });
    if (!company) throw BizException.badRequest('所属公司不存在');

    const dup = await this.employeeRepo.findOne({ where: { phone: p } });
    if (dup) throw BizException.badRequest(`手机号 ${p} 已存在（员工：${dup.name}）`);

    if (employeeNo) {
      const dupNo = await this.employeeRepo.findOne({
        where: { company_id: companyId, employee_no: String(employeeNo).trim() },
      });
      if (dupNo) throw BizException.badRequest(`工号 ${employeeNo} 在本公司内已存在`);
    }
  }

  private maskPhone(phone: string) {
    if (!phone || phone.length < 7) return phone;
    return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  }

  private startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private startOfMonth() {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  }
}
