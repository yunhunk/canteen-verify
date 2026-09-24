const api = require('../../utils/api');
const { getUser } = require('../../utils/request');

Page({
  data: {
    user: null,
    loading: true,
    todayConsumptions: 0,
    myConsumptions: 0,
    /** 当前是否处于可核销时段 */
    open: false,
    currentTime: '',
    /** 时段列表（已附上 limitText / stateText 供 WXML 直接用） */
    windows: [],
    /** 无规则时表示"不限制" */
    noLimit: false,
    /** 本人额度：null = 公司未设限制 */
    quotaTotal: null,
    quotaUsed: 0,
    quotaRemain: null,
    /** 是否受限（额度不为 null） */
    quotaLimited: false,
    /** 只剩 ≤1 次，文案变橙 */
    quotaLow: false,
    /** 已用完 */
    quotaExhausted: false,
    /** 公司餐标文案，如「15 元」/「未设置」 */
    mealStandardText: '',
    errorMsg: '',
  },

  onShow() {
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => wx.stopPullDownRefresh());
  },

  async loadAll() {
    this.setData({ loading: true, errorMsg: '' });
    try {
      const [me, stat, win] = await Promise.all([
        api.me(),
        api.myStatistics(),
        api.windows(),
      ]);

      // 个人额度：null = 不限制；0 次也算「已用完」
      const quotaTotal = me.quotaTotal === undefined ? null : me.quotaTotal;
      const quotaUsed = me.quotaUsed || 0;
      const quotaRemain = me.quotaRemain === undefined ? null : me.quotaRemain;
      const quotaLimited = quotaTotal !== null;

      this.setData({
        user: me,
        todayConsumptions: stat.today,
        myConsumptions: stat.total,
        open: win.open,
        currentTime: win.currentTime,
        windows: (win.windows || []).map((w) => ({
          ...w,
          limitText: this.buildLimitText(w),
          // 该时段今天已经用完，标灰提醒别再跑一趟
          limitUsed: w.remainToday === 0,
          stateText: w.active ? '进行中' : '未开始',
        })),
        noLimit: (win.windows || []).length === 0,
        quotaTotal,
        quotaUsed,
        quotaRemain,
        quotaLimited,
        quotaLow: quotaLimited && (quotaRemain || 0) <= 1,
        quotaExhausted: quotaLimited && (quotaRemain || 0) <= 0,
        mealStandardText: me.mealStandardText || '未设置',
        loading: false,
      });
    } catch (e) {
      // 401 已由 request.js 处理跳转，这里只兜其他错误
      this.setData({ loading: false, errorMsg: e.message || '加载失败' });
    }
  },

  /**
   * 某个时段「今日还可 N 次」的文案。
   *
   * remainToday 由后端算好（limit = 0 的时段返回 null，表示该时段不限次）；
   * 万一后端没给（旧版本），退回按 limit 判断，不要让页面出现 "undefined 次"。
   */
  buildLimitText(w) {
    const remain = w.remainToday;
    if (remain === null || remain === undefined) return '今日不限次';
    if (remain <= 0) return '今日次数已用完';
    return `今日还可 ${remain} 次`;
  },

  goQrcode() {
    wx.switchTab({ url: '/pages/qrcode/index' });
  },

  goRecords() {
    wx.switchTab({ url: '/pages/records/index' });
  },

  goMine() {
    wx.switchTab({ url: '/pages/mine/index' });
  },
});
