import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { login as loginApi, logout as logoutApi } from '@/api/auth';
import { setToken, clearToken, getToken } from '@/utils/request';

const USER_KEY = 'admin_user';

/**
 * 登录用户状态。
 *
 * 用 localStorage 持久化 —— 后台没有 refresh token 机制，
 * 靠 token 自身过期 + 后端 token_version 吊销（改密/停用立即失效）。
 */

/** 非组件环境（router 守卫）也要能读，所以另给一组裸函数 */
export function getUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function isLoggedIn() {
  return Boolean(getToken() && getUser());
}

export function setUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearUser() {
  localStorage.removeItem(USER_KEY);
}

export const useUserStore = defineStore('user', () => {
  const user = ref(getUser());

  const role = computed(() => user.value?.role || '');
  const isSuper = computed(() => role.value === 'super');
  const isCompany = computed(() => role.value === 'company');
  const displayName = computed(() => user.value?.name || user.value?.username || '未登录');

  async function login(payload) {
    const res = await loginApi(payload);
    setToken(res.token);
    setUser(res.user);
    user.value = res.user;
    return res.user;
  }

  /**
   * 登出（漏洞 04f84）。
   *
   * 先请求后端注销（token_version+1，服务端立即失效），
   * 再清本地 —— 顺序不能反：清了 token 就带不上 Authorization 头，
   * 后端无从知道该吊销谁。后端失败也要继续清本地，否则用户卡在登录态。
   */
  async function logout() {
    try {
      await logoutApi();
    } catch {
      /* 网络异常/已失效时忽略，本地登出照常进行 */
    }
    clearToken();
    clearUser();
    user.value = null;
  }

  return { user, role, isSuper, isCompany, displayName, login, logout };
});
