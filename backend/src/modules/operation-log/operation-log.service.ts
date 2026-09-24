import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { OperationLog } from '../../database/entities';

export interface RecordLogInput {
  companyId?: string | null;
  module: string;
  action: string;
  description?: string;
  operatorId?: string | null;
  operatorName?: string | null;
  operatorRole?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: unknown;
  ip?: string | null;
}

export interface QueryLogInput {
  companyId?: string | null;
  module?: string;
  action?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class OperationLogService {
  private readonly logger = new Logger('OperationLog');

  constructor(
    @InjectRepository(OperationLog) private readonly repo: Repository<OperationLog>,
  ) {}

  /**
   * 写入操作日志 —— **绝不抛异常**。
   *
   * 这是刻意的设计：日志表超时/写满时，绝不能反过来让一次正常核销失败。
   * 审计是旁路，不是主链路的一部分。失败只打堆栈，由监控去发现。
   */
  async record(input: RecordLogInput): Promise<void> {
    try {
      const log = this.repo.create({
        company_id: input.companyId ?? null,
        module: input.module,
        action: input.action,
        description: input.description ?? null,
        operator_id: input.operatorId ?? null,
        operator_name: input.operatorName ?? null,
        operator_role: input.operatorRole ?? null,
        target_type: input.targetType ?? null,
        target_id: input.targetId ?? null,
        detail: input.detail === undefined || input.detail === null
          ? null
          : JSON.stringify(input.detail),
        ip: input.ip ?? null,
      });
      await this.repo.save(log);
    } catch (e) {
      this.logger.error(`操作日志写入失败（已忽略，不影响主业务）：${(e as Error).message}`);
    }
  }

  /**
   * 查询日志
   *
   * - 公司端：companyId 强制取自 JWT，租户隔离
   * - 平台端：不传 companyId 则跨公司查
   */
  async query(input: QueryLogInput) {
    const page = Math.max(1, Number(input.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || 20));

    const qb = this.repo.createQueryBuilder('l').orderBy('l.id', 'DESC');

    if (input.companyId !== undefined && input.companyId !== null) {
      // 平台级操作（company_id 为空）也应能被超管查到；
      // 但公司端只能看到本公司自己的，不能看到平台级动作。
      if (input.companyId === '__PLATFORM__') {
        qb.andWhere('l.company_id IS NULL');
      } else {
        qb.andWhere('l.company_id = :cid', { cid: input.companyId });
      }
    }
    if (input.module) qb.andWhere('l.module = :m', { m: input.module });
    if (input.action) qb.andWhere('l.action = :a', { a: input.action });
    if (input.startDate) qb.andWhere('l.created_at >= :s', { s: `${input.startDate} 00:00:00` });
    if (input.endDate) qb.andWhere('l.created_at <= :e', { e: `${input.endDate} 23:59:59` });

    const [rows, total] = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return {
      total,
      page,
      pageSize,
      list: rows.map((r) => ({
        id: r.id,
        companyId: r.company_id,
        module: r.module,
        action: r.action,
        description: r.description,
        operatorId: r.operator_id,
        operatorName: r.operator_name,
        operatorRole: r.operator_role,
        targetType: r.target_type,
        targetId: r.target_id,
        // detail 存的是 JSON 串，回传时尽量还原成对象，前端直接可读
        detail: this.parseDetail(r.detail),
        ip: r.ip,
        createdAt: r.created_at,
      })),
    };
  }

  private parseDetail(raw: string | null) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
}
