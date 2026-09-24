import { Operator } from '../common/types/operator';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plan } from '../../database/entities';
import { BizException } from '../common/biz-code';
import { OperationLogService } from '../operation-log/operation-log.service';

@Injectable()
export class PlanService {
  constructor(
    @InjectRepository(Plan) private readonly planRepo: Repository<Plan>,
    private readonly logs: OperationLogService,
  ) {}

  async listAll() {
    const plans = await this.planRepo.find({ order: { id: 'ASC' } });
    return plans.map((p) => ({
      id: String(p.id),
      name: p.name,
      quota: p.quota,
      price: Number(p.price),
      validDays: p.valid_days,
      status: p.status,
      createdAt: p.created_at,
    }));
  }

  async create(
    dto: { name: string; quota: number; price?: number; validDays?: number; status?: number },
    operator: Operator,
    ip?: string | null,
  ) {
    if (!dto.name?.trim()) throw BizException.badRequest('套餐名称不能为空');
    const quota = Number(dto.quota);
    if (Number.isNaN(quota) || quota < 0) throw BizException.badRequest('包含次数必须是非负数字');

    const price = dto.price !== undefined ? Number(dto.price) : 0;
    if (Number.isNaN(price) || price < 0) throw BizException.badRequest('价格必须是非负数字');

    const validDays = dto.validDays !== undefined ? Number(dto.validDays) : 0;
    if (Number.isNaN(validDays) || validDays < 0) throw BizException.badRequest('有效天数必须是非负数字');

    const plan = await this.planRepo.save(
      this.planRepo.create({
        name: dto.name.trim(),
        quota: Math.floor(quota),
        price: price.toFixed(2),
        valid_days: Math.floor(validDays),
        status: dto.status !== undefined ? (Number(dto.status) === 1 ? 1 : 0) : 1,
      }),
    );

    await this.logs.record({
      companyId: null,
      module: 'plan',
      action: 'create',
      description: `新增套餐「${plan.name}」：${plan.quota} 次 / ￥${plan.price}`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'plan',
      targetId: plan.id,
      detail: {
        name: plan.name,
        quota: plan.quota,
        price: Number(plan.price),
        validDays: plan.valid_days,
      },
      ip,
    });

    return { id: String(plan.id) };
  }

  async update(
    id: string,
    dto: { name?: string; quota?: number; price?: number; validDays?: number; status?: number },
    operator: Operator,
    ip?: string | null,
  ) {
    const plan = await this.planRepo.findOne({ where: { id } });
    if (!plan) throw BizException.notFound('套餐不存在');

    const before = {
      name: plan.name,
      quota: plan.quota,
      price: Number(plan.price),
      validDays: plan.valid_days,
      status: plan.status,
    };

    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw BizException.badRequest('套餐名称不能为空');
      plan.name = dto.name.trim();
    }
    if (dto.quota !== undefined) {
      const q = Number(dto.quota);
      if (Number.isNaN(q) || q < 0) throw BizException.badRequest('包含次数必须是非负数字');
      plan.quota = Math.floor(q);
    }
    if (dto.price !== undefined) {
      const p = Number(dto.price);
      if (Number.isNaN(p) || p < 0) throw BizException.badRequest('价格必须是非负数字');
      plan.price = p.toFixed(2);
    }
    if (dto.validDays !== undefined) {
      const v = Number(dto.validDays);
      if (Number.isNaN(v) || v < 0) throw BizException.badRequest('有效天数必须是非负数字');
      plan.valid_days = Math.floor(v);
    }
    if (dto.status !== undefined) plan.status = Number(dto.status) === 1 ? 1 : 0;

    await this.planRepo.save(plan);

    await this.logs.record({
      companyId: null,
      module: 'plan',
      action: 'update',
      description: `编辑套餐「${plan.name}」`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'plan',
      targetId: plan.id,
      detail: {
        before,
        after: {
          name: plan.name,
          quota: plan.quota,
          price: Number(plan.price),
          validDays: plan.valid_days,
          status: plan.status,
        },
      },
      ip,
    });

    return { id: String(plan.id) };
  }
}
