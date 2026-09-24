import axios from 'axios';
import { ElMessage } from 'element-plus';

/**
 * 统一请求层。
 *
 * 和后端约定：业务码放在 body.code，HTTP 状态码另算。
 * 这里把 { code, message, data } 拆开 —— 业务成功直接把 data 交给调用方，
 * 失败则统一弹提示并 reject。页面里就不该再出现 if (res.code === 0)。
 */

const TOKEN_KEY = 'admin_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

const http = axios.create({
  baseURL: '/api',
  timeout: 20000,
});

http.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** 401 只跳一次，避免并发请求把登录页刷新多次 */
let redirecting = false;

http.interceptors.response.use(
  (res) => {
    // 文件下载（CSV）走 responseType: 'blob'，直接返回原始响应
    if (res.config.responseType === 'blob') return res;

    const body = res.data || {};
    if (body.code === 0) return body.data;

    const err = new Error(body.message || '请求失败');
    err.code = body.code;
    ElMessage.error(err.message);
    return Promise.reject(err);
  },
  (error) => {
    const status = error.response?.status;
    const body = error.response?.data || {};

    if (status === 401) {
      clearToken();
      if (!redirecting) {
        redirecting = true;
        ElMessage.error('登录已过期，请重新登录');
        setTimeout(() => {
          // 用 hash 跳转，避免依赖 router 实例造成的循环引用
          window.location.hash = '#/login';
          redirecting = false;
        }, 600);
      }
      const e = new Error(body.message || '登录已过期');
      e.code = 1001;
      return Promise.reject(e);
    }

    const msg =
      body.message ||
      (status ? `请求失败（HTTP ${status}）` : '网络异常，请检查后端服务是否已启动');
    ElMessage.error(msg);
    const e = new Error(msg);
    e.code = body.code;
    e.status = status;
    return Promise.reject(e);
  },
);

/** 触发浏览器下载（用于 CSV 导出） */
export async function download(url, params, filename) {
  const res = await http.get(url, { params, responseType: 'blob' });
  const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename || `export_${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

export default http;
