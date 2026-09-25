import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * 角色装饰器：@Roles('super') / @Roles('super', 'company')
 *
 * 与全局 RolesGuard 配合。**未加装饰器的受保护接口会被拒绝**
 * （fail-closed）—— 这样可以强制每个接口显式声明授权矩阵，
 * 避免「忘记加注解」变成静默的越权缺口。
 *
 * 若某接口确实需要对所有已登录角色开放，显式写 @Roles('super', 'company', 'employee')；
 * 若需要完全跳过登录校验，用 @Public()。
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/** 标记该接口允许未登录访问（跳过 JwtAuthGuard） */
export const PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** 标记该接口跳过租户守卫（如平台超管的跨公司查询） */
export const SKIP_TENANT_KEY = 'skipTenant';
export const SkipTenant = () => SetMetadata(SKIP_TENANT_KEY, true);
