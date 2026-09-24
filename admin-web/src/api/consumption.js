import http, { download } from '@/utils/request';

const buildFilename = (prefix) => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`;
};

/** 公司端 · 核销记录查询 / 趋势 / 导出 */
export const consumptionApi = {
  list: (params) => http.get('/company/consumptions', { params }),
  today: () => http.get('/company/consumptions/today'),
  trend: (days) => http.get('/company/consumptions/trend', { params: { days } }),
  export: (params) => download('/company/consumptions/export', params, buildFilename('核销记录')),
};

/** 平台端 · 核销记录（全租户，可指定 companyId） */
export const platformConsumptionApi = {
  list: (params) => http.get('/platform/consumptions', { params }),
  trend: (params) => http.get('/platform/consumptions/trend', { params }),
  export: (params) => download('/platform/consumptions/export', params, buildFilename('全平台核销记录')),
};
