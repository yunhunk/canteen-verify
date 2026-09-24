const { getUser, clearAuth } = require('./utils/request');

App({
  globalData: {
    user: null,
  },

  onLaunch() {
    this.globalData.user = getUser();
  },

  /** 登录态失效时由 request.js 调用，这里只做状态清理 */
  logout() {
    clearAuth();
    this.globalData.user = null;
    wx.reLaunch({ url: '/pages/login/index' });
  },
});
