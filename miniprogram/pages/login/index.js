const api = require('../../utils/api');
const { wxLogin, setAuth, getToken } = require('../../utils/request');

Page({
  data: {
    loading: false,
    /** null=测登录态中 / false=需要绑定 / true=已登录 */
    needBind: null,
    phone: '',
    employeeNo: '',
    errorMsg: '',
  },

  onLoad() {
    // 已有 token：直接进首页，避免每次都走一遍登录
    if (getToken()) {
      wx.switchTab({ url: '/pages/index/index' });
      return;
    }
    this.trySilentLogin();
  },

  /** 静默登录：老用户 openid 已绑定，无需再输手机号 */
  async trySilentLogin() {
    this.setData({ loading: true, errorMsg: '' });
    try {
      const code = await wxLogin();
      const res = await api.login({ code });
      this.setData({ loading: false });

      if (res.needBind) {
        this.setData({ needBind: true });
        return;
      }
      this.finishLogin(res);
    } catch (e) {
      this.setData({ loading: false, errorMsg: e.message || '登录失败，请重试' });
    }
  },

  onPhoneInput(e) {
    this.setData({ phone: e.detail.value, errorMsg: '' });
  },

  onEmployeeNoInput(e) {
    this.setData({ employeeNo: e.detail.value, errorMsg: '' });
  },

  /** 绑定并登录：手机号或工号至少填一个 */
  async onSubmit() {
    const { phone, employeeNo } = this.data;
    if (!phone && !employeeNo) {
      this.setData({ errorMsg: '请输入手机号或工号' });
      return;
    }
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
      this.setData({ errorMsg: '手机号格式不正确' });
      return;
    }

    this.setData({ loading: true, errorMsg: '' });
    try {
      const code = await wxLogin();
      const res = await api.login({ code, phone, employeeNo });
      this.setData({ loading: false });

      if (res.needBind) {
        this.setData({ errorMsg: '未匹配到员工信息，请确认手机号/工号' });
        return;
      }
      this.finishLogin(res);
    } catch (e) {
      this.setData({ loading: false, errorMsg: e.message || '绑定失败，请重试' });
    }
  },

  finishLogin(res) {
    setAuth(res.token, res.user);
    getApp().globalData.user = res.user;
    wx.showToast({ title: '登录成功', icon: 'success' });
    setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 500);
  },
});
