import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BizException } from '../biz-code';
import { PUBLIC_KEY } from '../decorators/roles.decorator';
import { JwtUser } from '../decorators/current-user.decorator';
import { Admin, Employee } from '../../../database/entities';

/**
 * 全局 JWT 守卫
 *
 * 分两段校验，成本与风险匹配：
 * 1. 员工 / 设备高频链路 —— 只验签名 + 一次主键查询比对 token_version；
 * 2. super / company 后台角色 —— 追加一次主键查库，校验
 *    a. 账号仍存在且 status = 1
 *    b. payload.tv === admins.token_version（否则说明已改密/停用/删除）
 *
 * 为什么第 2 段必要：JWT 默认 7 天有效且无状态，仅靠签名校验意味着
 * 超管把某管理员停用/改密/删除后，对方手里的旧 token 照样能用满 7 天。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @InjectRepository(Admin) private readonly adminRepo: Repository<Admin>,
    @InjectRepository(Employee) private readonly employeeRepo: Repository<Employee>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const auth: string = req.headers['authorization'] || '';
    if (!auth.startsWith('Bearer ')) {
      throw BizException.unauthorized();
    }
    const token = auth.slice(7).trim();

    let payload: JwtUser;
    try {
      payload = await this.jwt.verifyAsync<JwtUser>(token);
    } catch {
      throw BizException.unauthorized('登录已过期，请重新登录');
    }

    // 员工：查库只为比对 token_version，让「解绑微信」立刻生效
    //
    // 代价说明：这给每个员工请求加了一次主键查询——员工端原本是完全
    // 不查库的。愿意付这个成本，是因为不查库就没法让解绑生效：
    // 管理员在后台点了「解绑」，员工手机上却能凭旧 token 继续出码，
    // 这种"操作了但没生效"比多一次查询糟糕得多。主键命中、量级也小
    // （单公司几十上百人），可以接受。
    //
    // 这里**刻意不校验 status**：停用员工后的拦截由核销/出码的业务逻辑
    // 负责（那里本来就要读员工），守卫里重复一遍只会让两处规则各自演化。
    if (payload.role === 'employee') {
      const employee = await this.employeeRepo.findOne({ where: { id: payload.uid } });
      if (!employee) {
        throw BizException.sessionRevoked('账号不存在，请重新登录');
      }
      const expected = employee.token_version ?? 1;
      const actual = payload.tv === undefined ? 1 : payload.tv;
      if (actual !== expected) {
        throw BizException.sessionRevoked('微信绑定已解除，请重新登录');
      }
    }

    // 后台角色：追加查库校验会话是否被吊销
    if (payload.role === 'super' || payload.role === 'company') {
      const admin = await this.adminRepo.findOne({ where: { id: payload.uid } });
      if (!admin || admin.status !== 1) {
        throw BizException.sessionRevoked('账号已停用或被删除，请重新登录');
      }
      // 降级兼容：首次上线该机制时库里 token_version = 1，
      // 但已签发的旧 JWT 里没有 tv 字段 —— 按 1 处理，不把未改密账号踢下线
      const expected = admin.token_version ?? 1;
      const actual = payload.tv === undefined ? 1 : payload.tv;
      if (actual !== expected) {
        throw BizException.sessionRevoked('登录状态已失效，请重新登录');
      }
      // 以库中数据为准回填，避免 token 里的 companyId 被伪造利用
      payload.companyId = admin.company_id ?? null;
      payload.role = admin.role;
    }

    req.user = payload;
    return true;
  }
}
