import { Operator } from '../common/types/operator';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Store } from '../../database/entities';
import { BizException } from '../common/biz-code';
import { OperationLogService } from '../operation-log/operation-log.service';

@Injectable()
export class StoreService {
  constructor(
    @InjectRepository(Store) private readonly storeRepo: Repository<Store>,
    private readonly logs: OperationLogService,
  ) {}

  async listAll() {
    return this.storeRepo.find({ order: { id: 'ASC' } });
  }

  async create(
    dto: { name: string; companyId?: string },
    operator: Operator,
    ip?: string | null,
  ) {
    if (!dto.name?.trim()) throw BizException.badRequest('门店名称不能为空');

    const store = await this.storeRepo.save(
      this.storeRepo.create({
        name: dto.name.trim(),
        company_id: dto.companyId || null,
        status: 1,
      }),
    );

    await this.logs.record({
      companyId: null,
      module: 'store',
      action: 'create',
      description: `新增门店「${store.name}」`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'store',
      targetId: store.id,
      detail: { name: store.name, companyId: store.company_id },
      ip,
    });

    return { id: String(store.id) };
  }

  async update(
    id: string,
    dto: { name?: string; status?: number },
    operator: Operator,
    ip?: string | null,
  ) {
    const store = await this.storeRepo.findOne({ where: { id } });
    if (!store) throw BizException.notFound('门店不存在');

    const before = { name: store.name, status: store.status };
    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw BizException.badRequest('门店名称不能为空');
      store.name = dto.name.trim();
    }
    if (dto.status !== undefined) store.status = Number(dto.status) === 1 ? 1 : 0;
    await this.storeRepo.save(store);

    await this.logs.record({
      companyId: null,
      module: 'store',
      action: 'update',
      description: `编辑门店「${store.name}」`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'store',
      targetId: store.id,
      detail: { before, after: { name: store.name, status: store.status } },
      ip,
    });

    return { id: String(store.id) };
  }
}
