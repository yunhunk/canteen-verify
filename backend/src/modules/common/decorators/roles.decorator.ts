import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * 角色装饰器：@Roles('super') / @Roles('super', 'company')
 *
 * 与全局 RolesGuard 配合。未加装饰器的接口默认「已登录即可访问」。
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/** 标记该接口允许未登录访问（跳过 JwtAuthGuard） */
export const PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** 标记该接口跳过租户守卫（如平台超管的跨公司查询） */
export const SKIP_TENANT_KEY = 'skipTenant';
export const SkipTenant = () => SetMetadata(SKIP_TENANT_KEY, true);
