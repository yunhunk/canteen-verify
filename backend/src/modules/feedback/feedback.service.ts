import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Company, Employee, Feedback } from '../../database/entities';
import { BizException } from '../common/biz-code';
import { OperationLogService } from '../operation-log/operation-log.service';
import { Operator } from '../common/types/operator';

/** 允许的反馈类型 —— 白名单，防止前端传任意值污染统计 */
export const FEEDBACK_TYPES = ['issue', 'suggest', 'complaint', 'other'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const TYPE_LABEL: Record<string, string> = {
  issue: '问题反馈',
  suggest: '功能建议',
  complaint: '投诉',
  other: '其他',
};

export interface SubmitFeedbackInput {
  type?: string;
  title: string;
  content: string;
  contact?: string;
}

export interface QueryFeedbackInput {
  companyId?: string;
  type?: string;
  status?: number;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class FeedbackService {
  constructor(
    @InjectRepository(Feedback) private readonly repo: Repository<Feedback>,
    @InjectRepository(Employee) private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
    private readonly logs: OperationLogService,
  ) {}

  // ---------------------------------------------------------------
  // 员工端
  // ---------------------------------------------------------------

  /**
   * 员工提交反馈。
   *
   * companyId / employeeId 一律取自 JWT，**不接受客户端传入** ——
   * 否则员工可以伪造成别的公司提交，投诉数据就不可信了。
   */
  async submit(employeeId: string, companyId: string | null, input: SubmitFeedbackInput) {
    // 员工 token 里必定带 companyId（登录时写入）；缺了说明 token 异常，
    // 不能默默存成 null —— 那样反馈会从租户维度上"消失"。
    if (!companyId) throw BizException.forbidden('账号未绑定公司，无法提交反馈');

    const employee = await this.employeeRepo.findOne({ where: { id: employeeId } });
    if (!employee) throw BizException.notFound('员工不存在');

    const company = await this.companyRepo.findOne({ where: { id: companyId } });

    const type = FEEDBACK_TYPES.includes(input.type as FeedbackType)
      ? (input.type as string)
      : 'issue';

    const row = this.repo.create({
      company_id: companyId,
      employee_id: employeeId,
      employee_name: employee.name,
      company_name: company?.name ?? null,
      type,
      title: input.title.trim(),
      content: input.content.trim(),
      contact: input.contact?.trim() || null,
      status: 0,
    });
    const saved = await this.repo.save(row);

    // 记操作日志（companyId 传 null：这是员工行为而非管理员操作，
    // 归到平台视角更合适，也避免公司端日志页看到反馈相关痕迹）
    await this.logs.record({
      companyId: null,
      module: 'feedback',
      action: 'create',
      description: `员工「${employee.name}」提交了${TYPE_LABEL[type]}`,
      operatorId: employeeId,
      operatorName: employee.name,
      operatorRole: 'employee',
      targetType: 'feedback',
      targetId: String(saved.id),
    });

    return { id: String(saved.id) };
  }

  /** 员工查看自己的反馈历史（分页） */
  async myFeedbacks(employeeId: string, page = 1, pageSize = 20) {
    const p = Math.max(1, Number(page) || 1);
    const ps = Math.min(100, Math.max(1, Number(pageSize) || 20));

    const [rows, total] = await this.repo.findAndCount({
      where: { employee_id: employeeId },
      order: { id: 'DESC' },
      skip: (p - 1) * ps,
      take: ps,
    });

    return {
      total,
      page: p,
      pageSize: ps,
      list: rows.map((r) => this.toVo(r, { includeReply: true })),
    };
  }

  // ---------------------------------------------------------------
  // 平台端
  // ---------------------------------------------------------------

  /**
   * 平台查询反馈（跨公司）。
   *
   * 只提供给 @Roles('super') —— 公司端**没有任何反馈查询接口**，
   * 这是刻意的：员工投诉的对象常常就是公司本身。
   */
  async query(input: QueryFeedbackInput) {
    const p = Math.max(1, Number(input.page) || 1);
    const ps = Math.min(100, Math.max(1, Number(input.pageSize) || 20));

    const qb = this.repo.createQueryBuilder('f');

    if (input.companyId) qb.andWhere('f.company_id = :cid', { cid: input.companyId });
    if (input.type) qb.andWhere('f.type = :type', { type: input.type });
    if (input.status !== undefined && input.status !== null) {
      qb.andWhere('f.status = :st', { st: input.status });
    }
    if (input.keyword) {
      // 标题/内容/员工名 任一命中即可 —— 运营大多是"搜某个词"
      qb.andWhere(
        '(f.title LIKE :kw OR f.content LIKE :kw OR f.employee_name LIKE :kw)',
        { kw: `%${input.keyword}%` },
      );
    }

    const [rows, total] = await qb
      .orderBy('f.status', 'ASC') // 待处理排前面
      .addOrderBy('f.id', 'DESC')
      .skip((p - 1) * ps)
      .take(ps)
      .getManyAndCount();

    // 统计各状态数量，便于运营看"还有多少没处理"
    const pending = await this.repo.count({ where: { status: 0 } });

    return {
      total,
      page: p,
      pageSize: ps,
      pending,
      list: rows.map((r) => this.toVo(r, { includeReply: true })),
    };
  }

  async findOne(id: string) {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw BizException.notFound('反馈不存在');
    return row;
  }

  /** 平台回复 / 处理反馈 */
  async reply(
    id: string,
    reply: string,
    operator: Operator,
    ip: string | null,
  ) {
    const row = await this.findOne(id);
    const text = (reply || '').trim();
    if (!text) throw BizException.badRequest('回复内容不能为空');

    row.reply = text;
    row.status = 1;
    row.reply_admin_id = operator.uid ?? null;
    row.reply_admin_name = operator.name ?? null;
    row.replied_at = new Date();
    await this.repo.save(row);

    await this.logs.record({
      companyId: null,
      module: 'feedback',
      action: 'reply',
      description: `回复了员工「${row.employee_name ?? '-'}」的${TYPE_LABEL[row.type] ?? '反馈'}`,
      operatorId: operator.uid,
      operatorName: operator.name,
      operatorRole: operator.role,
      targetType: 'feedback',
      targetId: String(row.id),
      detail: { reply: text },
      ip,
    });

    return this.toVo(row, { includeReply: true });
  }

  /** 仅改状态（把「已处理」退回「待处理」等） */
  async setStatus(id: string, status: number, operator: Operator, ip: string | null) {
    const row = await this.findOne(id);
    row.status = status === 1 ? 1 : 0;
    await this.repo.save(row);

    await this.logs.record({
      companyId: null,
      module: 'feedback',
      action: 'status',
      description: `将反馈状态改为「${row.status === 1 ? '已处理' : '待处理'}」`,
      operatorId: operator.uid,
      operatorName: operator.name,
      operatorRole: operator.role,
      targetType: 'feedback',
      targetId: String(row.id),
      ip,
    });

    return this.toVo(row, { includeReply: true });
  }

  /** 平台待处理数量（给后台菜单角标用） */
  async pendingCount() {
    return { pending: await this.repo.count({ where: { status: 0 } }) };
  }

  // ---------------------------------------------------------------

  private toVo(r: Feedback, opts: { includeReply: boolean }) {
    return {
      id: String(r.id),
      companyId: String(r.company_id),
      companyName: r.company_name,
      employeeId: String(r.employee_id),
      employeeName: r.employee_name,
      type: r.type,
      typeLabel: TYPE_LABEL[r.type] ?? r.type,
      title: r.title,
      content: r.content,
      contact: r.contact,
      status: r.status,
      createdAt: r.created_at,
      ...(opts.includeReply
        ? {
            reply: r.reply,
            replyAdminName: r.reply_admin_name,
            repliedAt: r.replied_at,
          }
        : {}),
    };
  }
}
