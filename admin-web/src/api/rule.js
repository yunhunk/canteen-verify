import http from '@/utils/request';

/** 平台端 · 时段规则（公司级） */
export const platformRuleApi = {
  list: (params) => http.get('/platform/rules', { params }),
  create: (data) => http.post('/platform/rules', data),
  update: (id, data) => http.put(`/platform/rules/${id}`, data),
  setStatus: (id, status) => http.put(`/platform/rules/${id}/status`, { status }),
  remove: (id) => http.delete(`/platform/rules/${id}`),
};

/** 公司端 · 时段规则（只能操作本公司的） */
export const companyRuleApi = {
  list: () => http.get('/company/rules'),
  create: (data) => http.post('/company/rules', data),
  update: (id, data) => http.put(`/company/rules/${id}`, data),
  setStatus: (id, status) => http.put(`/company/rules/${id}/status`, { status }),
  remove: (id) => http.delete(`/company/rules/${id}`),
};
