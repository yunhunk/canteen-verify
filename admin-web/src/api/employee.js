import http from '@/utils/request';

/** 平台端 · 员工管理（含增删改 + 批量导入） */
export const platformEmployeeApi = {
  list: (params) => http.get('/platform/employees', { params }),
  create: (data) => http.post('/platform/employees', data),
  /** 逐行容错：个别行失败不回滚整批，返回 { success, failed, errors[] } */
  batch: (rows) => http.post('/platform/employees/batch', { rows }),
  update: (id, data) => http.put(`/platform/employees/${id}`, data),
  setStatus: (id, status) => http.put(`/platform/employees/${id}/status`, { status }),
  /** 解绑微信：清除该员工的 openid 绑定，并立刻吊销其登录态与未用二维码 */
  unbindWechat: (id) => http.post(`/platform/employees/${id}/unbind-wechat`),
};

/**
 * 公司端 · 员工
 *
 * quotaTotal 语义（三个值不能混）：
 * - null     → 不限制
 * - 0        → 一次都不允许
 * - 正整数   → 具体次数
 * 所以「不限」必须显式传 null，不能靠"不传"表达。
 */
export const companyEmployeeApi = {
  list: (params) => http.get('/company/employees', { params }),
  setStatus: (id, status) => http.put(`/company/employees/${id}/status`, { status }),
  /** 设置单人核销次数；resetUsed=true 时顺手把已用次数清零 */
  setQuota: (id, quotaTotal, resetUsed = false) =>
    http.put(`/company/employees/${id}/quota`, { quotaTotal, resetUsed }),
  /** 批量设置：勾选多人统一设为同一次数 */
  batchSetQuota: (employeeIds, quotaTotal) =>
    http.post('/company/employees/quota/batch', { employeeIds, quotaTotal }),
  /**
   * 解绑微信。
   *
   * 公司端必须能解绑：员工换微信后，新微信登录会被
   * 「该员工账号已绑定其他微信」拦住，只有管理员能解开。
   */
  unbindWechat: (id) => http.post(`/company/employees/${id}/unbind-wechat`),
};
