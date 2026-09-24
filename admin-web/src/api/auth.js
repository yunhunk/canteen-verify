import http, { download } from '@/utils/request';

/**
 * 登录（公司端 / 平台端共用入口）
 * 后端按返回的 user.role 分流，前端不需要分别调两个接口。
 */
export const login = (data) => http.post('/auth/admin/login', data);

/** 当前登录者信息 —— 后端没有 /me 接口，这里直接从登录响应里取，见 stores/user.js */

export const authApi = { login };
