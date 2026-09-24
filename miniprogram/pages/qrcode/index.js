const api = require('../../utils/api');

/** 二维码倒计时刷新：小于该秒数时自动换新码 */
const REFRESH_AHEAD_SECONDS = 20;

/** 已核销感知轮询间隔（毫秒）：核销完成后最多 2 秒占位区变「已完成」 */
const WATCH_INTERVAL_MS = 2000;

Page({
  data: {
    loading: true,
    qrToken: '',
    /** 后端返回的二维码图片（SVG data URL），直接交给 <image> 渲染 */
    qrImageUrl: '',
    /** 二维码内容：只放 token，核销端拿它调接口 */
    qrContent: '',
    expireAt: '',
    remainSeconds: 0,
    countdownText: '',
    /** 当前是否在可核销时段 */
    open: true,
    /** 非核销时段：不出码，展示时段列表 */
    closed: false,
    /** 公司未配置任何时段规则 = 不限制，随时可核销 */
    noLimit: false,
    windows: [],
    currentTime: '',
    openText: '',
    /** 例如「距离「午餐」开始还有 25 分钟」 */
    nextWindowText: '',
    /** 本人剩余核销次数：null 表示公司未设限制 */
    quotaTotal: null,
    quotaUsed: 0,
    quotaRemain: null,
    /** 例如「剩余 3 次」/「剩余次数不限」 */
    quotaText: '',
    /** 只剩 ≤1 次：文案变橙提醒 */
    quotaLow: false,
    /** 公司餐标文案，如「15 元」/「未设置」。来自 windows 接口，发码接口不带 */
    mealStandardText: '',
    /** 次数已用完：优先级高于「非时段」，因为这是更硬的阻塞 */
    noQuota: false,
    errorMsg: '',
    /** 当前码已被核销：二维码占位切换为「已完成」（含套餐档名） */
    used: false,
    /** 核销时段名（套餐档），如「午餐」；无规则公司为空 */
    usedWindowName: '',
    /** 核销完成时间（HH:mm），空表示后端没给 */
    usedTimeText: '',
  },

  onLoad() {
    this.init();
  },

  onShow() {
    // 从别的 tab 切回来时，如果码已失效就重新拿一张。
    // 非时段 / 次数用完时本来就没码，靠 init() 重新检测
    //（用户可能已经等到时段开始，或管理员刚给加了次数）。
    if (this.data.closed || this.data.noQuota) {
      this.init();
      return;
    }
    if (this.data.qrToken && this.data.remainSeconds <= 0) {
      this.refreshQrcode();
      return;
    }
    // 有码但中途离开了页面：轮询也停过，回来先立即查一次，
    // 离开期间被核销的话马上就能看到「已完成」
    if (this.data.qrToken && !this.data.used) {
      this.pollStatusOnce();
    }
    this.startWatch();
  },

  onHide() {
    this.stopTimer();
    this.stopWatch();
  },

  onUnload() {
    this.stopTimer();
    this.stopWatch();
  },

  async init() {
    this.setData({ loading: true, errorMsg: '', used: false });
    this.stopWatch();
    try {
      const win = await api.windows();
      const windows = win.windows || [];
      const noLimit = windows.length === 0;
      const open = win.open;

      // 个人额度：null = 不限制；0 次也算「用尽」
      const quotaTotal = win.quotaTotal === undefined ? null : win.quotaTotal;
      const quotaUsed = win.quotaUsed || 0;
      const quotaRemain = win.quotaRemain === undefined ? null : win.quotaRemain;
      const noQuota = quotaTotal !== null && (quotaRemain || 0) <= 0;

      this.setData({
        open,
        noLimit,
        windows,
        currentTime: win.currentTime,
        openText: this.buildOpenText(win),
        // 次数用完时优先呈现「次数用完」——比「不在时段」更贴近真实原因，
        // 也更可操作（员工知道该去找公司管理员，而不是等到饭点再来）
        noQuota,
        closed: !open && !noLimit && !noQuota,
        nextWindowText: !open && !noLimit ? this.buildNextWindowText(windows, win.currentTime) : '',
        quotaTotal,
        quotaUsed,
        quotaRemain,
        quotaText: this.buildQuotaText(quotaTotal, quotaRemain),
        quotaLow: quotaTotal !== null && (quotaRemain || 0) <= 1,
        // 餐标来自 windows 接口；发码接口不带，所以 refreshQrcode 里不能覆盖它
        mealStandardText: win.mealStandardText || '',
      });

      // 非时段 or 次数用完：都不出码，也不调发码接口。
      // 后端在两种情况下同样会拒绝发码（双保险，防绕过客户端）。
      if ((!open && !noLimit) || noQuota) {
        this.setData({
          loading: false,
          qrToken: '',
          qrImageUrl: '',
          qrContent: '',
          remainSeconds: 0,
          countdownText: '',
        });
        this.stopTimer();
        return;
      }

      await this.refreshQrcode();
    } catch (e) {
      // 后端也可能以 2005（不在可核销时段）拒绝发码 —— 此时应走"非时段"呈现，
      // 而不是把它当成一个加载失败的错误。
      if (e && e.code === 2005) {
        this.setData({
          loading: false,
          closed: true,
          noQuota: false,
          open: false,
          errorMsg: '',
          openText: e.message || '当前不在可核销时段',
          nextWindowText: '',
        });
        this.stopTimer();
        return;
      }
      // 2007 = 员工个人次数已用完（与 2002 公司总额度不足区分）
      if (e && e.code === 2007) {
        this.setData({
          loading: false,
          closed: false,
          noQuota: true,
          open: false,
          errorMsg: '',
          quotaRemain: 0,
          quotaText: this.buildQuotaText(this.data.quotaTotal, 0),
          quotaLow: true,
        });
        this.stopTimer();
        return;
      }
      this.setData({ loading: false, errorMsg: e.message || '加载失败' });
    }
  },

  /** 剩余次数的展示文案：null 一律显示「不限」，避免出现"剩余 null 次" */
  buildQuotaText(total, remain) {
    if (total === null || total === undefined) return '剩余次数不限';
    return `剩余 ${remain || 0} 次`;
  },

  buildOpenText(win) {
    if ((win.windows || []).length === 0) return '公司未设置时段限制，随时可核销';
    if (win.open) {
      const active = win.windows.filter((w) => w.active);
      return active.length
        ? `当前可核销：${active.map((w) => w.name).join('、')}`
        : '当前可核销';
    }
    return '当前不在可核销时段';
  },

  /**
   * 算「距离下一个时段还有多久」，给用户一个明确的等待预期。
   *
   * 跨天时段（22:00-02:00）不能简单用「当天的 22:00」来算：
   * 凌晨 01:00 时，下一个时段其实就在眼前（就是当前这个时段的后半段，
   * 属于昨天 22:00 开始的窗口）—— 但那种情况 active 必为 true，
   * 走不到这里。所以这里只需处理"今天还没开始"或"今天已结束"。
   */
  buildNextWindowText(windows, currentTime) {
    if (!windows.length || !currentTime) return '';

    const toMin = (hhmm) => {
      const [h, m] = String(hhmm).split(':').map(Number);
      return h * 60 + m;
    };
    const nowMin = toMin(currentTime);

    // 取第一个还没结束的时段（按开始时间升序）作为"下一个"
    const upcoming = windows
      .filter((w) => !w.crossDay && toMin(w.startTime) > nowMin)
      .sort((a, b) => toMin(a.startTime) - toMin(b.startTime))[0];

    if (!upcoming) return '今日时段已结束，请明天再来';

    const diff = toMin(upcoming.startTime) - nowMin;
    if (diff < 60) return `距离「${upcoming.name}」开始还有 ${diff} 分钟`;
    const h = Math.floor(diff / 60);
    const m = diff % 60;
    return m
      ? `距离「${upcoming.name}」开始还有 ${h} 小时 ${m} 分钟`
      : `距离「${upcoming.name}」开始还有 ${h} 小时`;
  },

  async refreshQrcode() {
    try {
      const res = await api.issueQrcode();
      const quotaTotal = res.quotaTotal === undefined ? null : res.quotaTotal;
      const quotaRemain = res.quotaRemain === undefined ? null : res.quotaRemain;
      this.setData({
        loading: false,
        closed: false,
        noQuota: false,
        errorMsg: '',
        // 新码到手：清掉上一张的「已完成」占位，回到正常出码展示
        used: false,
        usedWindowName: '',
        usedTimeText: '',
        qrToken: res.qrToken,
        qrImageUrl: res.qrImageUrl || '',
        qrContent: res.qrToken,
        expireAt: res.expireAt,
        remainSeconds: res.ttlSeconds,
        quotaTotal,
        quotaUsed: res.quotaUsed || 0,
        quotaRemain,
        quotaText: this.buildQuotaText(quotaTotal, quotaRemain),
        quotaLow: quotaTotal !== null && (quotaRemain || 0) <= 1,
      });
      this.startTimer();
      this.startWatch();
    } catch (e) {
      // 发码时刚好跨出时段边界 → 切成"非时段"呈现，而不是报错
      if (e && e.code === 2005) {
        this.setData({
          loading: false,
          closed: true,
          noQuota: false,
          open: false,
          errorMsg: '',
          openText: e.message || '当前不在可核销时段',
        });
        this.stopTimer();
        return;
      }
      // 发码时刚好把最后一次用完 → 切到"次数用完"呈现
      if (e && e.code === 2007) {
        this.setData({
          loading: false,
          closed: false,
          noQuota: true,
          open: false,
          errorMsg: '',
          quotaRemain: 0,
          quotaText: this.buildQuotaText(this.data.quotaTotal, 0),
          quotaLow: true,
        });
        this.stopTimer();
        return;
      }
      this.setData({ loading: false, errorMsg: e.message || '获取二维码失败' });
    }
  },

  startTimer() {
    this.stopTimer();
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  // ---------------------------------------------------------------
  // 已核销感知：轮询当前码状态，核销完成立即切换「已完成」占位
  // ---------------------------------------------------------------

  startWatch() {
    this.stopWatch();
    if (!this.data.qrToken || this.data.used) return;
    // 有码才轮询；请求串行化（watching 门闩）避免慢网络下请求堆积
    this.watch = setInterval(() => this.pollStatusOnce(), WATCH_INTERVAL_MS);
  },

  stopWatch() {
    if (this.watch) {
      clearInterval(this.watch);
      this.watch = null;
    }
  },

  async pollStatusOnce() {
    if (!this.data.qrToken || this.data.used || this.watching) return;
    this.watching = true;
    try {
      const st = await api.qrcodeStatus();
      if (st && st.state === 'consumed') this.markConsumed(st);
    } catch (e) {
      // 网络抖动不打断出码展示：下一轮再问
    } finally {
      this.watching = false;
    }
  },

  /** 核销完成：二维码占位切换为「已完成」，停掉倒计时与轮询 */
  markConsumed(st) {
    const usedTimeText = st.verifyTime ? this.formatTimeText(st.verifyTime) : '';
    this.setData({
      used: true,
      usedWindowName: st.windowName || '',
      usedTimeText,
    });
    this.stopTimer();
    this.stopWatch();
  },

  /**「再来一码」：清掉已完成占位，回到正常出码流程 */
  onIssueAgain() {
    this.refreshQrcode();
    wx.showToast({ title: '新码已生成', icon: 'none' });
  },

  /** 后端时间字符串（ISO 或 "yyyy-MM-dd HH:mm:ss"）→ HH:mm */
  formatTimeText(t) {
    const d = new Date(t);
    if (isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  },

  tick() {
    const expire = new Date(this.data.expireAt).getTime();
    const remain = Math.max(0, Math.round((expire - Date.now()) / 1000));

    const mm = String(Math.floor(remain / 60)).padStart(2, '0');
    const ss = String(remain % 60).padStart(2, '0');

    this.setData({ remainSeconds: remain, countdownText: `${mm}:${ss}` });

    if (remain <= 0) {
      this.stopTimer();
      // 过期自动换新。若此刻已跨出时段，refreshQrcode 会切到"非时段"呈现。
      this.refreshQrcode();
      return;
    }

    // 快过期时提前换，避免核销员刚扫就过期
    if (remain <= REFRESH_AHEAD_SECONDS && !this.refreshing) {
      this.refreshing = true;
      this.refreshQrcode().finally(() => {
        this.refreshing = false;
      });
    }
  },

  onManualRefresh() {
    this.refreshing = true;
    this.refreshQrcode().finally(() => {
      this.refreshing = false;
    });
    wx.showToast({ title: '已刷新', icon: 'none' });
  },

  /** 非时段时的快捷反馈入口 —— 这条路径上的用户投诉意愿最强 */
  goFeedback() {
    wx.navigateTo({ url: '/pages/feedback/index?from=qrcode' });
  },

  onSaveTip() {
    wx.showToast({ title: '请直接向核销员出示', icon: 'none' });
  },
});
