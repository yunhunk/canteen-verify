import http, { download } from '@/utils/request';

/**
 * 登录（公司端 / 平台端共用入口）
 * 后端按返回的 user.role 分流，前端不需要分别调两个接口。
 */
export const login = (data) => http.post('/auth/admin/login', data);

/**
 * 服务端登出（漏洞 04f84）。
 *
 * 仅清前端 token 是不够的：JWT 在过期前仍然有效，若被中间人截获，
 * 即便用户已"退出"，攻击者仍能继续用。调用后端登出会把
 * token_version +1，使该账号**已签发的全部 token 立即作废**。
 */
export const logout = () => http.post('/auth/logout');

export const authApi = { login, logout };
