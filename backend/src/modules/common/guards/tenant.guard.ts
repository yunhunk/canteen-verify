import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BizException } from '../biz-code';
import { JwtUser } from '../decorators/current-user.decorator';
import { SKIP_TENANT_KEY } from '../decorators/roles.decorator';

/**
 * 租户守卫：多租户「共享库 + company_id 行级隔离」的强制点。
 *
 * 规则：
 * - super（平台超管，companyId = null）→ 放行，可跨租户查询；
 * - company（公司管理员）→ 必须带 companyId，否则拒绝（配置错误的账号
 *   绝不能看到跨租户数据）；
 * - 其他角色（员工）→ 只能访问 own 资源，由各 service 按 companyId 过滤。
 *
 * 这里只做「身份与租户是否自洽」的兜底拦截；
 * 真正的数据过滤在各 service 的 QueryBuilder 里注入 WHERE company_id = ?。
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user as JwtUser;
    if (!user) return true; // 公开接口

    // super 可跨租户；其余角色必须有明确租户归属
    if (user.role === 'super') return true;

    if (user.companyId === null || user.companyId === undefined || user.companyId === '') {
      throw BizException.forbidden('账号未绑定公司，无法访问业务数据');
    }
    return true;
  }
}
