import { Operator } from '../common/types/operator';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { Admin, Company } from '../../database/entities';
import { BizException } from '../common/biz-code';
import { OperationLogService } from '../operation-log/operation-log.service';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(Admin) private readonly adminRepo: Repository<Admin>,
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
    private readonly logs: OperationLogService,
  ) {}

  /**
   * 管理账号列表
   *
   * 带 isSelf 标记：前端据此把「停用 / 删除」按钮置灰并给出原因 ——
   * 避免用户点了才吃报错（后端仍然硬拦，前端只是体验层）。
   */
  async listAll(currentUserId?: string) {
    const admins = await this.adminRepo.find({ order: { id: 'ASC' } });
    const companyIds = [...new Set(admins.map((a) => a.company_id).filter(Boolean))] as string[];
    const companies = companyIds.length
      ? await this.companyRepo.find({ where: companyIds.map((id) => ({ id })) })
      : [];
    const cMap = new Map(companies.map((c) => [String(c.id), c.name]));

    return admins.map((a) => ({
      id: String(a.id),
      username: a.username,
      role: a.role,
      companyId: a.company_id ? String(a.company_id) : null,
      companyName: a.company_id ? cMap.get(String(a.company_id)) ?? null : null,
      status: a.status,
      isSelf: currentUserId ? String(a.id) === String(currentUserId) : false,
      createdAt: a.created_at,
    }));
  }

  async create(
    dto: { username: string; password: string; role?: string; companyId?: string },
    operator: Operator,
    ip?: string | null,
  ) {
    const username = String(dto.username || '').trim();
    if (!username) throw BizException.badRequest('账号不能为空');
    if (username.length < 3 || username.length > 50) {
      throw BizException.badRequest('账号长度需在 3-50 个字符之间');
    }
    if (!dto.password || String(dto.password).length < 8) {
      throw BizException.badRequest('密码至少 8 位，且需包含字母和数字');
    }
    if (!/(?=.*[a-zA-Z])(?=.*\d)/.test(String(dto.password))) {
      throw BizException.badRequest('密码需同时包含字母和数字');
    }

    const role = dto.role === 'super' ? 'super' : 'company';

    // 先查重给出可读的 400，而不是让唯一约束炸出 500
    const dup = await this.adminRepo.findOne({ where: { username } });
    if (dup) throw BizException.badRequest(`账号 ${username} 已存在`);

    // 角色与公司归属必须自洽，否则会造出一个「看不到任何数据」的账号
    if (role === 'company') {
      if (!dto.companyId) throw BizException.badRequest('公司管理员必须指定所属公司');
      const company = await this.companyRepo.findOne({ where: { id: dto.companyId } });
      if (!company) throw BizException.badRequest('所属公司不存在');
    } else if (dto.companyId) {
      throw BizException.badRequest('平台超管不能绑定公司');
    }

    const admin = await this.adminRepo.save(
      this.adminRepo.create({
        username,
        password_hash: await bcrypt.hash(String(dto.password), BCRYPT_ROUNDS),
        role,
        company_id: role === 'company' ? dto.companyId : null,
        status: 1,
        token_version: 1,
      }),
    );

    await this.logs.record({
      companyId: admin.company_id,
      module: 'admin',
      action: 'create',
      description: `创建${role === 'super' ? '平台超管' : '公司管理员'}账号「${username}」`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'admin',
      targetId: admin.id,
      detail: { username, role, companyId: admin.company_id },
      ip,
    });

    return { id: String(admin.id) };
  }

  /**
   * 修改 / 重置密码
   *
   * 三个保护：
   * 1. 改**自己**必须提供原密码 —— 否则 token 被盗后攻击者能直接
   *    改密把真超管锁在外面。
   * 2. 新密码不能与原密码相同 —— 否则「改密」这个动作等于没发生，
   *    但 token_version 却递增了，语义混乱。
   * 3. 成功后 token_version++ → 所有旧 token 立即失效。
   */
  async changePassword(
    targetId: string,
    dto: { newPassword: string; oldPassword?: string },
    operator: Operator,
    ip?: string | null,
  ) {
    const admin = await this.adminRepo.findOne({ where: { id: targetId } });
    if (!admin) throw BizException.notFound('账号不存在');

    if (!dto.newPassword || String(dto.newPassword).length < 8) {
      throw BizException.badRequest('新密码至少 8 位，且需包含字母和数字');
    }
    if (!/(?=.*[a-zA-Z])(?=.*\d)/.test(String(dto.newPassword))) {
      throw BizException.badRequest('新密码需同时包含字母和数字');
    }

    const isSelf = String(operator?.uid) === String(admin.id);

    if (isSelf) {
      if (!dto.oldPassword) {
        throw BizException.badRequest('修改自己的密码需要提供原密码');
      }
      const ok = await bcrypt.compare(String(dto.oldPassword), admin.password_hash);
      if (!ok) throw BizException.badRequest('原密码不正确');
    }

    const same = await bcrypt.compare(String(dto.newPassword), admin.password_hash);
    if (same) throw BizException.badRequest('新密码不能与原密码相同');

    admin.password_hash = await bcrypt.hash(String(dto.newPassword), BCRYPT_ROUNDS);
    admin.token_version = (admin.token_version ?? 1) + 1;
    await this.adminRepo.save(admin);

    await this.logs.record({
      companyId: admin.company_id,
      module: 'admin',
      action: 'reset_password',
      description: `${isSelf ? '修改' : '重置'}账号「${admin.username}」的密码，其旧登录已立即失效`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'admin',
      targetId: admin.id,
      detail: { username: admin.username, isSelf, tokenVersion: admin.token_version },
      ip,
    });

    return { id: String(admin.id) };
  }

  /**
   * 停用 / 启用
   *
   * 防自锁：不能停自己（正在操作的会话会当场失效，把自己关在门外），
   * 也不能停最后一个启用的超管（平台将永久失去管理入口）。
   */
  async setStatus(
    targetId: string,
    status: number,
    operator: Operator,
    ip?: string | null,
  ) {
    const admin = await this.adminRepo.findOne({ where: { id: targetId } });
    if (!admin) throw BizException.notFound('账号不存在');

    const next = Number(status) === 1 ? 1 : 0;
    const isSelf = String(operator?.uid) === String(admin.id);

    if (next === 0) {
      if (isSelf) throw BizException.selfLock('不能停用当前登录的账号');
      if (admin.role === 'super') await this.assertNotLastSuperAdmin(admin.id, '停用');
    }

    const before = admin.status;
    admin.status = next;
    // 停用/启用都递增：启用时递增是为了让停用期间可能被签发的 token 也失效
    admin.token_version = (admin.token_version ?? 1) + 1;
    await this.adminRepo.save(admin);

    await this.logs.record({
      companyId: admin.company_id,
      module: 'admin',
      action: 'status',
      description: `${next === 1 ? '启用' : '停用'}账号「${admin.username}」，其已有登录状态已失效`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'admin',
      targetId: admin.id,
      detail: { username: admin.username, before: { status: before }, after: { status: next } },
      ip,
    });

    return { id: String(admin.id), status: next };
  }

  /** 硬删除。同样受自锁保护 */
  async remove(
    targetId: string,
    operator: Operator,
    ip?: string | null,
  ) {
    const admin = await this.adminRepo.findOne({ where: { id: targetId } });
    if (!admin) throw BizException.notFound('账号不存在');

    if (String(operator?.uid) === String(admin.id)) {
      throw BizException.selfLock('不能删除当前登录的账号');
    }
    if (admin.role === 'super') await this.assertNotLastSuperAdmin(admin.id, '删除');

    const snapshot = { username: admin.username, role: admin.role, companyId: admin.company_id };
    await this.adminRepo.delete({ id: admin.id });

    await this.logs.record({
      companyId: admin.company_id,
      module: 'admin',
      action: 'delete',
      description: `删除账号「${admin.username}」`,
      operatorId: operator?.uid,
      operatorName: operator?.name,
      operatorRole: operator?.role,
      targetType: 'admin',
      targetId: admin.id,
      detail: { deleted: snapshot },
      ip,
    });

    return { id: String(admin.id) };
  }

  /**
   * 校验「不能动最后一个启用的超管」。
   *
   * 注意这里统计的是 **status=1 的 super 且排除自己**：
   * 若有 2 个启用超管，停掉其中一个还剩 1 个，是安全的；
   * 只剩 1 个时任何停用/删除都会让平台彻底失去入口。
   */
  private async assertNotLastSuperAdmin(excludeId: string, action: string) {
    const others = await this.adminRepo
      .createQueryBuilder('a')
      .where('a.role = :r', { r: 'super' })
      .andWhere('a.status = 1')
      .andWhere('a.id != :id', { id: excludeId })
      .getCount();

    if (others === 0) {
      throw BizException.selfLock(`「${action}」会移除最后一个启用的平台超管，平台将失去管理入口`);
    }
  }
}
