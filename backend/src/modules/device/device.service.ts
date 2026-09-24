import { Operator } from '../common/types/operator';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Device, Store } from '../../database/entities';
import { BizException } from '../common/biz-code';
import { OperationLogService } from '../operation-log/operation-log.service';
import { generateDeviceKey } from '../common/utils/device-key';

@Injectable()
export class DeviceService {
  constructor(
    @InjectRepository(Device) private readonly deviceRepo: Repository<Device>,
    @InjectRepository(Store) private readonly storeRepo: Repository<Store>,
    private readonly logs: OperationLogService,
  ) {}

  /**
   * 设备列表
   *
   * **绝不返回 key_hash** —— 虽然哈希本身不足以直接盗用，
   * 但它是对密钥做离线爆破的输入，没有理由给出去。
   * 列表只展示 key_prefix 供人辨识。
   */
  async listAll() {
    const devices = await this.deviceRepo.find({ order: { id: 'DESC' } });
    const storeIds = [...new Set(devices.map((d) => d.store_id).filter(Boolean))] as string[];
    const stores = storeIds.length
      ? await this.storeRepo.find({ where: { id: In(storeIds) } })
      : [];
    const storeMap = new Map(stores.map((s) => [String(s.id), s.name]));

    return devices.map((d) => ({
      id: String(d.id),
      name: d.name,
      keyPrefix: d.key_prefix,
      storeId: d.store_id ? String(d.store_id) : null,
      storeName: d.store_id ? storeMap.get(String(d.store_id)) ?? null : null,
      companyId: d.company_id ? String(d.company_id) : null,
      status: d.status,
      lastUsedAt: d.last_used_at,
      createdAt: d.created_at,
    }));
  }

  /**
   * 登记设备：**明文密钥仅返回一次**
   *
   * 库里只存 sha256。这意味着密钥丢了只能换发、无法找回 ——
   * 这正是设计意图：一个能找回的密钥，也就能被拖库的人拿到。
   */
  async create(
    dto: { name: string; storeId?: string; companyId?: string },
    operator: Operator,
    ip?: string | null,
  ) {
    if (!dto.name?.trim()) throw BizException.badRequest('设备名称不能为空');
    await this.assertStore(dto.storeId);

    const { plain, hash, prefix } = generateDeviceKey();

    const device = await this.deviceRepo.save(
      this.deviceRepo.create({
        name: dto.name.trim(),
        key_hash: hash,
        key_prefix: prefix,
        store_id: dto.storeId || null,
        company_id: dto.companyId || null,
        status: 1,
      }),
    );

    await this.logs.record({
      companyId: null,
      module: 'device',
      action: 'create',
      description: `登记核销设备「${device.name}」${dto.storeId ? '，绑定门店' : ''}`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'device',
      targetId: device.id,
      detail: { name: device.name, keyPrefix: prefix, storeId: device.store_id },
      ip,
    });

    return {
      id: String(device.id),
      name: device.name,
      keyPrefix: prefix,
      // 只在这一个响应里出现，之后任何接口都不会再返回
      deviceKey: plain,
      warning: '设备密钥仅显示这一次，请立即妥善保存',
    };
  }

  async update(
    id: string,
    dto: { name?: string; storeId?: string; companyId?: string; status?: number },
    operator: Operator,
    ip?: string | null,
  ) {
    const device = await this.deviceRepo.findOne({ where: { id } });
    if (!device) throw BizException.notFound('设备不存在');

    const before = {
      name: device.name,
      storeId: device.store_id ? String(device.store_id) : null,
      companyId: device.company_id ? String(device.company_id) : null,
      status: device.status,
    };

    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw BizException.badRequest('设备名称不能为空');
      device.name = dto.name.trim();
    }
    if (dto.storeId !== undefined) {
      await this.assertStore(dto.storeId);
      device.store_id = dto.storeId || null;
    }
    if (dto.companyId !== undefined) device.company_id = dto.companyId || null;
    if (dto.status !== undefined) device.status = Number(dto.status) === 1 ? 1 : 0;

    await this.deviceRepo.save(device);

    await this.logs.record({
      companyId: null,
      module: 'device',
      action: 'update',
      description:
        dto.status !== undefined && before.status !== device.status
          ? `${device.status === 1 ? '启用' : '停用'}核销设备「${device.name}」`
          : `编辑核销设备「${device.name}」`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'device',
      targetId: device.id,
      detail: {
        before,
        after: {
          name: device.name,
          storeId: device.store_id ? String(device.store_id) : null,
          companyId: device.company_id ? String(device.company_id) : null,
          status: device.status,
        },
      },
      ip,
    });

    return { id: String(device.id) };
  }

  /**
   * 换发密钥：旧密钥立即失效。
   *
   * 实现上直接把 key_hash 覆盖掉 —— 旧 hash 在库里不再存在，
   * 拿旧密钥来查就是查不到，天然失效，无需额外黑名单。
   */
  async rotateKey(
    id: string,
    operator: Operator,
    ip?: string | null,
  ) {
    const device = await this.deviceRepo.findOne({ where: { id } });
    if (!device) throw BizException.notFound('设备不存在');

    const oldPrefix = device.key_prefix;
    const { plain, hash, prefix } = generateDeviceKey();
    device.key_hash = hash;
    device.key_prefix = prefix;
    await this.deviceRepo.save(device);

    await this.logs.record({
      companyId: null,
      module: 'device',
      action: 'rotate_key',
      description: `换发核销设备「${device.name}」密钥（${oldPrefix}… → ${prefix}…），旧密钥立即失效`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'device',
      targetId: device.id,
      detail: { oldPrefix, newPrefix: prefix },
      ip,
    });

    return {
      id: String(device.id),
      name: device.name,
      keyPrefix: prefix,
      deviceKey: plain,
      warning: '新密钥仅显示这一次，旧密钥已立即失效',
    };
  }

  private async assertStore(storeId?: string) {
    if (!storeId) return;
    const store = await this.storeRepo.findOne({ where: { id: storeId } });
    if (!store) throw BizException.badRequest('绑定的门店不存在');
  }
}
