import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BizException } from '../biz-code';
import { ROLES_KEY, PUBLIC_KEY } from '../decorators/roles.decorator';
import { JwtUser } from '../decorators/current-user.decorator';

/**
 * 角色守卫（fail-closed）
 *
 * ## 为什么改成「未声明角色即拒绝」
 *
 * 原实现是 fail-open：接口若未声明 @Roles，任何已登录主体都能访问。
 * 这让「忘记加注解」从编译期问题退化成静默的越权缺口 —— 实际已导致
 * POST /api/verify/scan、GET /api/company/remain、GET /api/employee/windows
 * 三处越权（员工令牌可扣他人公司额度、读他人公司配额）。
 *
 * 现在改为：**未声明 @Roles 的受保护接口一律拒绝**，并在启动时打出告警，
 * 迫使每个接口显式声明自己的授权矩阵。
 *
 * 例外：标了 @Public 的接口（登录、设备核销）不经过本守卫的登录态校验，
 * 由各自的鉴权机制（设备密钥 / 登录接口）负责，此处直接放行。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger('RolesGuard');

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // @Public 接口走自己的鉴权路径（如设备密钥），不受角色矩阵约束
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      // fail-closed：未声明授权矩阵 = 配置缺失，拒绝并告警
      const handler = context.getHandler()?.name ?? 'unknown';
      const cls = context.getClass()?.name ?? 'unknown';
      this.logger.error(
        `⛔ ${cls}.${handler} 未声明 @Roles，已按 fail-closed 策略拒绝。` +
          `请在控制器上补 @Roles(...) 或 @Public()。`,
      );
      throw BizException.forbidden('接口未配置访问策略，已拒绝');
    }

    const req = context.switchToHttp().getRequest();
    const user = req.user as JwtUser;
    if (!user) throw BizException.unauthorized();

    if (!required.includes(user.role)) {
      throw BizException.forbidden('当前角色无权访问该接口');
    }
    return true;
  }
}
