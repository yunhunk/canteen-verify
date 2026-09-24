import http from '@/utils/request';

export const storeApi = {
  list: () => http.get('/platform/stores'),
  create: (data) => http.post('/platform/stores', data),
  update: (id, data) => http.put(`/platform/stores/${id}`, data),
};

export const planApi = {
  list: () => http.get('/platform/plans'),
  create: (data) => http.post('/platform/plans', data),
  update: (id, data) => http.put(`/platform/plans/${id}`, data),
};

/**
 * 后台账号管理。
 * 服务端做了自锁保护（不能停用/删除自己、不能停用最后一个超管），
 * 前端把 isSelf 用上做按钮置灰，能少一次无谓的报错往返。
 */
export const adminApi = {
  list: () => http.get('/platform/admins'),
  create: (data) => http.post('/platform/admins', data),
  changePassword: (id, password) => http.put(`/platform/admins/${id}/password`, { password }),
  setStatus: (id, status) => http.put(`/platform/admins/${id}/status`, { status }),
  remove: (id) => http.delete(`/platform/admins/${id}`),
};

export const logApi = {
  platform: (params) => http.get('/platform/operation-logs', { params }),
  company: (params) => http.get('/company/operation-logs', { params }),
};
