import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BizException } from '../biz-code';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { JwtUser } from '../decorators/current-user.decorator';

/**
 * 角色守卫
 *
 * 约定：接口若未声明 @Roles，则「已登录即可访问」。
 * 员工增删接口仅 super 可访问；company 角色仅开放 status 更新接口。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user as JwtUser;
    if (!user) throw BizException.unauthorized();

    if (!required.includes(user.role)) {
      throw BizException.forbidden('当前角色无权访问该接口');
    }
    return true;
  }
}
