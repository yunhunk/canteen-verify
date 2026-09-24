/**
 * 统一请求封装
 *
 * 三件事必须在这里做掉，否则会散落到每个页面：
 * 1. 自动带 token、401 自动跳登录
 * 2. 把后端 { code, message, data } 拍平 —— 页面只关心 data，
 *    只在 code != 0 时抛错，避免每个调用点都写 if (res.code === 0)
 * 3. 网络失败给出人能看懂的提示
 */

/**
 * 后端地址。
 *
 * 分环境配置，避免改地址要动代码：
 * - 开发者工具本地联调：走本机后端
 * - 真机 / 体验版 / 正式版：必须是**已备案的 https 域名**，
 *   并在小程序后台「开发管理 → 服务器域名」里配为 request 合法域名。
 *
 * HTTP 的裸 IP 只能用于开发者工具勾选「不校验合法域名」时调试，
 * 真机上一律会被微信拦截 —— 上线前务必换成 https 域名。
 */
const ENV = 'prod'; // 'local' | 'prod'

const BASE_URL =
  ENV === 'local'
    ? 'http://127.0.0.1:3311'
    : 'https://tuancan.gengle.xyz'; // 生产：HTTPS 域名（需在小程序后台配为 request 合法域名）

const TOKEN_KEY = 'access_token';
const USER_KEY = 'user_info';

function getToken() {
  try {
    return wx.getStorageSync(TOKEN_KEY) || '';
  } catch (e) {
    return '';
  }
}

function setAuth(token, user) {
  wx.setStorageSync(TOKEN_KEY, token);
  if (user) wx.setStorageSync(USER_KEY, user);
}

function getUser() {
  try {
    return wx.getStorageSync(USER_KEY) || null;
  } catch (e) {
    return null;
  }
}

function clearAuth() {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(USER_KEY);
}

let redirecting = false;

/** 401 时统一跳登录页，避免多个并发请求同时触发跳转 */
function handleUnauthorized() {
  clearAuth();
  if (redirecting) return;
  redirecting = true;
  wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
  setTimeout(() => {
    wx.reLaunch({
      url: '/pages/login/index',
      complete: () => {
        redirecting = false;
      },
    });
  }, 800);
}

function request(options) {
  const { url, method = 'GET', data = {}, silent = false } = options;

  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + url,
      method,
      data,
      header: {
        'Content-Type': 'application/json',
        Authorization: getToken() ? `Bearer ${getToken()}` : '',
      },
      success(res) {
        const body = res.data || {};

        if (res.statusCode === 401) {
          handleUnauthorized();
          reject({ code: 1001, message: body.message || '登录已过期' });
          return;
        }

        if (body.code === 0) {
          resolve(body.data);
          return;
        }

        const err = { code: body.code, message: body.message || '请求失败' };
        if (!silent) {
          wx.showToast({ title: err.message, icon: 'none', duration: 2500 });
        }
        reject(err);
      },
      fail(e) {
        const msg = '网络异常，请检查网络后重试';
        if (!silent) wx.showToast({ title: msg, icon: 'none' });
        reject({ code: -1, message: msg, detail: e });
      },
    });
  });
}

/** wx.login 的 Promise 化 */
function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => (res.code ? resolve(res.code) : reject({ message: '未获取到 code' })),
      fail: () => reject({ message: '微信登录失败，请重试' }),
    });
  });
}

module.exports = {
  BASE_URL,
  request,
  wxLogin,
  getToken,
  setAuth,
  getUser,
  clearAuth,
  get: (url, data, opts) => request({ url, method: 'GET', data, ...opts }),
  post: (url, data, opts) => request({ url, method: 'POST', data, ...opts }),
};
