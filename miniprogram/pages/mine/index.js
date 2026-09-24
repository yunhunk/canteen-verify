const api = require('../../utils/api');
const { clearAuth } = require('../../utils/request');

Page({
  data: {
    user: null,
    loading: true,
    /** 我的统计：总数 / 今日 / 本月 */
    stat: { total: 0, today: 0, month: 0 },
    /** 剩余核销次数文案：null 额度统一显示「不限」 */
    quotaText: '',
    /** 额度已用尽：给一条显眼的提示 */
    quotaExhausted: false,
    errorMsg: '',
  },

  onShow() {
    this.loadAll();
  },

  async loadAll() {
    this.setData({ loading: true, errorMsg: '' });
    try {
      // me() 也会返回一份统计，但 statistics 是权威口径，两个都取以免口径漂移
      const [me, stat] = await Promise.all([api.me(), api.myStatistics()]);
      const quotaTotal = me.quotaTotal === undefined ? null : me.quotaTotal;
      const quotaRemain = me.quotaRemain === undefined ? null : me.quotaRemain;
      this.setData({
        user: me,
        stat: {
          total: stat.total ?? 0,
          today: stat.today ?? 0,
          month: stat.month ?? 0,
        },
        quotaText: this.buildQuotaText(quotaTotal, quotaRemain),
        quotaExhausted: quotaTotal !== null && (quotaRemain || 0) <= 0,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false, errorMsg: e.message || '加载失败' });
    }
  },

  /** 剩余次数文案：null（公司未设限）统一显示「不限」，不暴露 null */
  buildQuotaText(total, remain) {
    if (total === null || total === undefined) return '不限';
    return `${remain || 0} 次`;
  },

  goRecords() {
    wx.switchTab({ url: '/pages/records/index' });
  },
  goQrcode() {
    wx.switchTab({ url: '/pages/qrcode/index' });
  },

  goFeedback() {
    wx.navigateTo({ url: '/pages/feedback/index' });
  },

  /** 退出登录：清本地态 + 重启到登录页 */
  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新验证身份才能核销，确定退出吗？',
      confirmText: '退出',
      confirmColor: '#e53e3e',
      success: (res) => {
        if (!res.confirm) return;
        clearAuth();
        const app = getApp();
        if (app && app.globalData) app.globalData.user = null;
        wx.reLaunch({ url: '/pages/login/index' });
      },
    });
  },

  /** 未绑定/账号停用时引导重新登录 */
  onRelogin() {
    clearAuth();
    wx.reLaunch({ url: '/pages/login/index' });
  },

  onCopyEmployeeNo() {
    const no = this.data.user && this.data.user.employeeNo;
    if (!no) return;
    wx.setClipboardData({ data: String(no) });
  },
});
