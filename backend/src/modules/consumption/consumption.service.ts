import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Company, Consumption, Employee, Store } from '../../database/entities';

export interface ConsumptionQuery {
  companyId?: string | null;
  employeeId?: string;
  storeId?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class ConsumptionService {
  constructor(
    @InjectRepository(Consumption) private readonly consumptionRepo: Repository<Consumption>,
    @InjectRepository(Employee) private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(Store) private readonly storeRepo: Repository<Store>,
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
  ) {}

  /**
   * 消费记录查询（联表返回员工姓名/工号、门店名、公司名）
   *
   * 租户隔离：companyId 非空时强制过滤 —— 这是公司端与平台端的唯一区别，
   * 公司端调进来时 companyId 一定取自 JWT，不接受请求参数覆盖。
   */
  async query(q: ConsumptionQuery) {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20));

    const qb = this.consumptionRepo.createQueryBuilder('c').orderBy('c.verify_time', 'DESC');
    if (q.companyId) qb.andWhere('c.company_id = :cid', { cid: q.companyId });
    if (q.employeeId) qb.andWhere('c.employee_id = :eid', { eid: q.employeeId });
    if (q.storeId) qb.andWhere('c.store_id = :sid', { sid: q.storeId });
    if (q.startDate) qb.andWhere('c.verify_time >= :s', { s: `${q.startDate} 00:00:00` });
    if (q.endDate) qb.andWhere('c.verify_time <= :e', { e: `${q.endDate} 23:59:59` });

    const [rows, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    const enriched = await this.enrich(rows);

    return { total, page, pageSize, list: enriched };
  }

  /** 导出用：同一套筛选条件，但不分页 */
  async queryForExport(q: ConsumptionQuery) {
    const qb = this.consumptionRepo.createQueryBuilder('c').orderBy('c.verify_time', 'DESC');
    if (q.companyId) qb.andWhere('c.company_id = :cid', { cid: q.companyId });
    if (q.employeeId) qb.andWhere('c.employee_id = :eid', { eid: q.employeeId });
    if (q.storeId) qb.andWhere('c.store_id = :sid', { sid: q.storeId });
    if (q.startDate) qb.andWhere('c.verify_time >= :s', { s: `${q.startDate} 00:00:00` });
    if (q.endDate) qb.andWhere('c.verify_time <= :e', { e: `${q.endDate} 23:59:59` });
    qb.take(50000); // 兜底上限，防止一次拉爆内存
    return this.enrich(await qb.getMany());
  }

  /** 批量补全关联名称，避免 N+1 */
  private async enrich(rows: Consumption[]) {
    if (rows.length === 0) return [];

    const employeeIds = [...new Set(rows.map((r) => String(r.employee_id)))];
    const storeIds = [...new Set(rows.map((r) => r.store_id).filter(Boolean))] as string[];
    const companyIds = [...new Set(rows.map((r) => String(r.company_id)))];

    const [employees, stores, companies] = await Promise.all([
      this.employeeRepo.find({ where: { id: In(employeeIds) } }),
      storeIds.length ? this.storeRepo.find({ where: { id: In(storeIds) } }) : Promise.resolve([]),
      companyIds.length ? this.companyRepo.find({ where: { id: In(companyIds) } }) : Promise.resolve([]),
    ]);

    const eMap = new Map(employees.map((e) => [String(e.id), e]));
    const sMap = new Map(stores.map((s) => [String(s.id), s]));
    const cMap = new Map(companies.map((c) => [String(c.id), c]));

    return rows.map((r) => ({
      id: String(r.id),
      companyId: String(r.company_id),
      companyName: cMap.get(String(r.company_id))?.name ?? null,
      employeeId: String(r.employee_id),
      employeeName: eMap.get(String(r.employee_id))?.name ?? null,
      employeeNo: eMap.get(String(r.employee_id))?.employee_no ?? null,
      phone: eMap.get(String(r.employee_id))?.phone ?? null,
      storeId: r.store_id ? String(r.store_id) : null,
      storeName: r.store_id ? sMap.get(String(r.store_id))?.name ?? null : null,
      verifyTime: r.verify_time,
      deductQuota: r.deduct_quota,
      ruleId: r.rule_id ? String(r.rule_id) : null,
    }));
  }

  /**
   * 核销趋势：近 N 天按日聚合。
   *
   * 用 SQL 按日分组 + 应用层补零 —— 不能让「零核销的那天」从图表里消失，
   * 否则趋势线会误导人以为天天都有量。
   */
  async trend(params: { companyId?: string | null; days?: number }) {
    const days = Math.min(90, Math.max(1, Number(params.days) || 14));

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));

    // 按日聚合。MySQL 与 SQLite 的日期函数不同名，这里按方言切换
    const isSqlite = this.consumptionRepo.manager.connection.options.type === 'sqljs';
    const dayExpr = isSqlite
      ? "strftime('%Y-%m-%d', c.verify_time)"
      : "DATE_FORMAT(c.verify_time, '%Y-%m-%d')";

    const qb = this.consumptionRepo
      .createQueryBuilder('c')
      .select(dayExpr, 'day')
      .addSelect('COUNT(*)', 'cnt')
      .where('c.verify_time >= :start', { start });
    if (params.companyId) qb.andWhere('c.company_id = :cid', { cid: params.companyId });
    qb.groupBy('day');

    const raw = await qb.getRawMany();
    const map = new Map(raw.map((r) => [String(r.day), Number(r.cnt)]));

    const result: Array<{ date: string; count: number }> = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = this.formatDate(d);
      result.push({ date: key, count: map.get(key) ?? 0 });
    }
    return result;
  }

  async todayCount(companyId?: string | null) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const qb = this.consumptionRepo
      .createQueryBuilder('c')
      .where('c.verify_time >= :s', { s: start });
    if (companyId) qb.andWhere('c.company_id = :cid', { cid: companyId });
    return qb.getCount();
  }

  /**
   * 生成 CSV（UTF-8 BOM，Excel 直开不乱码）
   *
   * BOM 不是可选项：中文 Windows 上的 Excel 默认按 GBK 解读无 BOM 的 UTF-8，
   * 员工姓名会变成乱码，而对账时这份表是要给人看的。
   */
  async buildCsv(q: ConsumptionQuery): Promise<string> {
    const rows = await this.queryForExport(q);
    const header = [
      '核销时间',
      '公司',
      '员工姓名',
      '工号',
      '手机号',
      '核销门店',
      '扣减次数',
    ];

    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          this.formatDateTime(r.verifyTime),
          this.csvCell(r.companyName),
          this.csvCell(r.employeeName),
          this.csvCell(r.employeeNo),
          this.csvCell(r.phone),
          this.csvCell(r.storeName),
          String(r.deductQuota ?? 1),
        ].join(','),
      );
    }
    return '\uFEFF' + lines.join('\r\n');
  }

  /** 含逗号/引号/换行的字段必须加引号并把内部引号翻倍，否则会串列 */
  private csvCell(v: unknown): string {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\r\n]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  private formatDate(d: Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private formatDateTime(d: Date) {
    if (!d) return '';
    const date = new Date(d);
    return `${this.formatDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(
      date.getMinutes(),
    ).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  }
}
