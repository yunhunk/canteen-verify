const api = require('../../utils/api');

/** 反馈类型（与后端 FEEDBACK_TYPES 一致） */
const TYPES = [
  { value: 'issue', label: '问题反馈', icon: '⚠️' },
  { value: 'suggest', label: '功能建议', icon: '💡' },
  { value: 'complaint', label: '投诉', icon: '📣' },
  { value: 'other', label: '其他', icon: '💬' },
];

const PAGE_SIZE = 20;

Page({
  data: {
    tab: 'submit',
    types: TYPES,

    // 提交表单
    form: { type: 'issue', title: '', content: '', contact: '' },
    submitting: false,

    // 历史
    history: [],
    historyTotal: 0,
    historyPage: 1,
    historyLoading: false,
    loadingMore: false,
    hasMore: false,

    /** 从核销码页跳转过来时给一条针对性提示 */
    fromQrcode: false,
  },

  onLoad(options) {
    this.setData({ fromQrcode: options && options.from === 'qrcode' });
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab });
    if (tab === 'history' && this.data.history.length === 0) {
      this.loadHistory(true);
    }
  },

  // ---------------- 表单 ----------------

  onPickType(e) {
    this.setData({ 'form.type': e.currentTarget.dataset.value });
  },

  onTitleInput(e) {
    this.setData({ 'form.title': e.detail.value });
  },

  onContentInput(e) {
    this.setData({ 'form.content': e.detail.value });
  },

  onContactInput(e) {
    this.setData({ 'form.contact': e.detail.value });
  },

  async onSubmit() {
    if (this.data.submitting) return;

    const { type, title, content, contact } = this.data.form;
    const t = (title || '').trim();
    const c = (content || '').trim();

    if (!t) {
      wx.showToast({ title: '请填写标题', icon: 'none' });
      return;
    }
    if (!c) {
      wx.showToast({ title: '请填写详细描述', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    try {
      await api.submitFeedback({ type, title: t, content: c, contact: (contact || '').trim() });
      wx.showToast({ title: '提交成功，感谢反馈', icon: 'success' });

      // 清空表单并切到历史页，让用户看到自己刚提交的那条
      this.setData({
        form: { type: 'issue', title: '', content: '', contact: '' },
        tab: 'history',
        history: [],
        historyPage: 1,
      });
      await this.loadHistory(true);
    } catch (e) {
      // request.js 已弹过提示，这里不重复弹
    } finally {
      this.setData({ submitting: false });
    }
  },

  // ---------------- 历史 ----------------

  async loadHistory(reset = false) {
    if (this.data.historyLoading || this.data.loadingMore) return;

    const page = reset ? 1 : this.data.historyPage;
    this.setData(reset ? { historyLoading: true } : { loadingMore: true });

    try {
      const res = await api.myFeedbacks(page, PAGE_SIZE);
      const list = (res.list || []).map((it) => this.decorate(it));
      const merged = reset ? list : this.data.history.concat(list);
      const total = res.total || 0;

      this.setData({
        history: merged,
        historyTotal: total,
        historyPage: page,
        hasMore: merged.length < total,
      });
    } catch (e) {
      // 静默：列表加载失败不该打断用户
    } finally {
      this.setData({ historyLoading: false, loadingMore: false });
    }
  },

  loadMore() {
    if (!this.data.hasMore) return;
    this.setData({ historyPage: this.data.historyPage + 1 });
    this.loadHistory(false);
  },

  /** 时间格式化放在 JS 里，wxml 不写 WXS —— 与其它页面保持一致 */
  decorate(it) {
    return {
      ...it,
      timeText: this.fmtTime(it.createdAt),
      replyTimeText: it.repliedAt ? this.fmtTime(it.repliedAt) : '',
    };
  },

  fmtTime(v) {
    if (!v) return '';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  onPullDownRefresh() {
    if (this.data.tab === 'history') {
      this.loadHistory(true).finally(() => wx.stopPullDownRefresh());
    } else {
      wx.stopPullDownRefresh();
    }
  },
});
