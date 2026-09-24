import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface JwtUser {
  /** 员工 id 或管理员 id */
  uid: string;
  /** 租户 id；平台超管为 null */
  companyId: string | null;
  /** employee / company / super */
  role: string;
  /** 会话版本：管理员改密/停用、员工解绑微信时递增，旧 token 随之失效 */
  tv?: number;
  /** 仅员工：姓名，便于日志快照 */
  name?: string;
}

/** 从 request.user 取当前登录者（由 JwtAuthGuard 注入） */
export const CurrentUser = createParamDecorator(
  (field: keyof JwtUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as JwtUser;
    return field ? user?.[field] : user;
  },
);

/** 取请求 IP：兼容 Nginx 反代（X-Forwarded-For 首段才是真实来源） */
export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim().slice(0, 45);
  }
  return (req.ip || req.socket?.remoteAddress || '').slice(0, 45) || null;
});
