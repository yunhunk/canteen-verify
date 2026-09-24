const api = require('../../utils/api');

const PAGE_SIZE = 20;

Page({
  data: {
    list: [],
    loading: true,
    loadingMore: false,
    hasMore: true,
    total: 0,
    errorMsg: '',
  },

  /** 页码由已加载条数反推，避免和 setData 异步打架 */
  get page() {
    return Math.floor(this.data.list.length / PAGE_SIZE) + 1;
  },

  onLoad() {
    this.loadFirstPage();
  },

  onShow() {
    // 刚核销完回来，第一页可能已过期 —— 静默刷新一次
    if (this.loadedOnce) {
      this.setData({ loading: false });
      this.doLoadFirstPage(true);
    }
    this.loadedOnce = true;
  },

  onPullDownRefresh() {
    this.doLoadFirstPage().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  loadFirstPage() {
    return this.doLoadFirstPage();
  },

  async doLoadFirstPage(silent) {
    if (!silent) this.setData({ loading: true, errorMsg: '' });
    try {
      const res = await api.myConsumptions(1, PAGE_SIZE);
      this.setData({
        list: (res.list || []).map(this.decorate),
        total: res.total,
        hasMore: (res.list || []).length >= PAGE_SIZE,
        loading: false,
        errorMsg: '',
      });
    } catch (e) {
      this.setData({ loading: false, errorMsg: e.message || '加载失败' });
    }
  },

  /** 重试：拉第一页 */
  retry() {
    return this.doLoadFirstPage();
  },

  async loadMore() {
    if (this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    try {
      const res = await api.myConsumptions(this.page, PAGE_SIZE);
      const more = (res.list || []).map(this.decorate);
      this.setData({
        list: this.data.list.concat(more),
        hasMore: more.length >= PAGE_SIZE,
        loadingMore: false,
      });
    } catch (e) {
      this.setData({ loadingMore: false });
    }
  },

  /**
   * 把后端字段转成界面直接能用的形状。
   *
   * 后端 verifyTime 是 ISO 字符串，直接展示会带上 T 和毫秒，很难看；
   * 时间格式化放在这里，wxml 里就不用写 WXS。
   */
  decorate(item) {
    const d = item.verifyTime ? new Date(item.verifyTime) : null;
    return {
      id: item.id,
      storeName: item.storeName || '未知门店',
      deductQuota: item.deductQuota,
      dateText: d ? `${d.getMonth() + 1}月${d.getDate()}日` : '--',
      timeText: d ? this.hhmm(d) : '--:--',
      weekText: d ? '周' + '日一二三四五六'[d.getDay()] : '',
      fullText: d ? `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())} ${this.hhmm(d)}` : '',
    };
  },

  hhmm(d) {
    return `${this.pad(d.getHours())}:${this.pad(d.getMinutes())}`;
  },

  pad(n) {
    return String(n).padStart(2, '0');
  },
});
