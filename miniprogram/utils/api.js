/**
 * 员工端接口封装
 *
 * 路径集中在这里，避免散落在各页面 —— 后端改路径时只改一处。
 * check:miniapp 会校验这些路径与后端路由一致。
 */
const { get, post } = require('./request');

module.exports = {
  /** 微信登录 / 绑定。未绑定时返回 { needBind: true } */
  login: (payload) => post('/api/employee/login', payload),

  /** 我的信息（含今日可核销时段） */
  me: () => get('/api/employee/me'),

  /** 我的统计（总数 / 今日 / 本月） */
  myStatistics: () => get('/api/employee/statistics'),

  /** 我的消费记录 */
  myConsumptions: (page = 1, pageSize = 20) =>
    get('/api/employee/consumptions', { page, pageSize }),

  /** 获取新的动态二维码（一次性、5 分钟有效） */
  issueQrcode: () => get('/api/employee/qrcode'),

  /** 我的当前码状态：active（有效）/ consumed（已核销，含时段名）/ none */
  qrcodeStatus: () => get('/api/employee/qrcode/status'),

  /** 今日可核销时段 + 当前是否开放（仅用于界面提示） */
  windows: () => get('/api/employee/windows'),

  /** 提交反馈 */
  submitFeedback: (payload) => post('/api/employee/feedbacks', payload),

  /** 我的反馈历史 */
  myFeedbacks: (page = 1, pageSize = 20) =>
    get('/api/employee/feedbacks', { page, pageSize }),
};
