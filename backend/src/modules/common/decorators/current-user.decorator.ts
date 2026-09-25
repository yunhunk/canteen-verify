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

/**
 * 取请求 IP
 *
 * ## 为什么不能直接读 X-Forwarded-For 首段
 *
 * 早期实现取 XFF 的**第一个**分段，理由是「反代场景下首段才是真实来源」。
 * 这在 nginx 使用 `$proxy_add_x_forwarded_for` 时不成立 —— 该变量是
 * **追加**语义：客户端自带 `X-Forwarded-For: 1.2.3.4`，nginx 转发后变成
 * `1.2.3.4, <真实IP>`。首段完全由攻击者控制。
 *
 * 后果有两层，都很严重：
 *   1. **限流绕过**：以 IP 为键的计数器（设备核销 30 次/分）随请求头
 *      轮换而失效，等于没有限流；
 *   2. **审计污染**：伪造值被写进操作日志，事后无法取证。
 *
 * ## 现在的策略（优先级从高到低）
 *
 *   1. `X-Real-IP` —— nginx 用 `$remote_addr` 设置，是**覆写**语义，
 *      不受客户端输入影响。由部署方的 nginx 配置保证可信。
 *   2. Express `req.ip` —— 需配合 `app.set('trust proxy', ...)`，
 *      由 Express 按受信跳数从右往左剥离 XFF，取到的是真实对端。
 *   3. `req.socket.remoteAddress` —— 直连场景的真实来源。
 *
 * 三者都取不到时返回 null，调用方需按「来源未知」处理（不要归并到同一个键，
 * 否则会成为共享桶）。所有返回值统一截断到 45 字符以适配日志列宽。
 */
export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest();
  const pick = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s ? s.slice(0, 45) : null;
  };

  // 1. nginx 覆写的 X-Real-IP（部署配置保证：proxy_set_header X-Real-IP $remote_addr）
  const realIp = pick(req.headers['x-real-ip']);
  if (realIp) return realIp;

  // 2. Express 在 trust proxy 生效后解析出的 req.ip
  const expressIp = pick(req.ip);
  if (expressIp) return expressIp;

  // 3. 直连对端
  return pick(req.socket?.remoteAddress);
});
