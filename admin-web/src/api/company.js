import http from '@/utils/request';

/** 平台端 · 公司管理 */
export const companyApi = {
  list: (params) => http.get('/platform/companies', { params }),
  statistics: () => http.get('/platform/statistics'),
  create: (data) => http.post('/platform/companies', data),
  update: (id, data) => http.put(`/platform/companies/${id}`, data),
  /**
   * 设置 / 清除公司餐标 —— **只有平台端有这条口子**。
   *
   * 公司管理员能在「公司设置」里看到当前餐标，但改不了：
   * 餐标决定核销机器对外播报的价格口径，由平台统一掌握。
   *
   * 传 null = 清除（机器只说「核销成功」）；传数字 = 设为该餐标。
   */
  setMealStandard: (id, mealStandard) =>
    http.put(`/platform/companies/${id}/meal-standard`, { mealStandard }),
};

/** 公司端 · 统计看板与剩余次数、公司设置 */
export const companySelfApi = {
  statistics: () => http.get('/company/statistics'),
  remain: () => http.get('/company/remain'),
  /**
   * 公司设置（当前只有餐标）—— **只读**。
   *
   * 返回 { mealStandard, mealStandardText, tiers, maxStandard }。
   * 这里没有对应的写接口：餐标由平台管理员设置（companyApi.setMealStandard）。
   * 档位仍会下发，好让管理员知道有哪些档、能跟平台说同一个数。
   */
  settings: () => http.get('/company/settings'),
};
