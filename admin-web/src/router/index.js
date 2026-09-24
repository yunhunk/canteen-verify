import { createRouter, createWebHashHistory } from 'vue-router';
import { getUser, isLoggedIn } from '@/stores/user';

/**
 * 路由表按角色分两棵子树：
 * - /platform/*  → 平台总后台（role = super）
 * - /company/*   → 公司后台（role = company）
 *
 * meta.roles 是前端的第一道闸（体验层）。真正的权限判定在后端 ——
 * 前端守卫只负责"不该看的页面别让它闪一下"，不是安全边界。
 */
const routes = [
  { path: '/', redirect: '/login' },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/login/index.vue'),
    meta: { public: true, title: '登录' },
  },

  // ── 平台端 ──
  {
    path: '/platform',
    component: () => import('@/layouts/AdminLayout.vue'),
    meta: { roles: ['super'] },
    redirect: '/platform/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'platform-dashboard',
        component: () => import('@/views/platform/Dashboard.vue'),
        meta: { title: '总览看板', icon: 'Odometer' },
      },
      {
        path: 'companies',
        name: 'platform-companies',
        component: () => import('@/views/platform/Companies.vue'),
        meta: { title: '公司管理', icon: 'OfficeBuilding' },
      },
      {
        path: 'employees',
        name: 'platform-employees',
        component: () => import('@/views/platform/Employees.vue'),
        meta: { title: '员工管理', icon: 'User' },
      },
      {
        path: 'consumptions',
        name: 'platform-consumptions',
        component: () => import('@/views/platform/Consumptions.vue'),
        meta: { title: '核销记录', icon: 'Tickets' },
      },
      {
        path: 'devices',
        name: 'platform-devices',
        component: () => import('@/views/platform/Devices.vue'),
        meta: { title: '核销设备', icon: 'Iphone' },
      },
      {
        path: 'rules',
        name: 'platform-rules',
        component: () => import('@/views/platform/Rules.vue'),
        meta: { title: '时段规则', icon: 'Clock' },
      },
      {
        path: 'stores-plans',
        name: 'platform-stores-plans',
        component: () => import('@/views/platform/StoresPlans.vue'),
        meta: { title: '门店与套餐', icon: 'Shop' },
      },
      {
        path: 'admins',
        name: 'platform-admins',
        component: () => import('@/views/platform/Admins.vue'),
        meta: { title: '后台账号', icon: 'Lock' },
      },
      {
        path: 'logs',
        name: 'platform-logs',
        component: () => import('@/views/platform/Logs.vue'),
        meta: { title: '操作日志', icon: 'Document' },
      },
      {
        // ⚠️ 反馈只在平台端菜单出现 —— 公司管理员看不到本公司员工的反馈。
        // 这不只是"前端不显示"：后端也没有给公司的反馈接口。
        path: 'feedbacks',
        name: 'platform-feedbacks',
        component: () => import('@/views/platform/Feedbacks.vue'),
        meta: { title: '意见反馈', icon: 'ChatDotSquare' },
      },
    ],
  },

  // ── 公司端 ──
  {
    path: '/company',
    component: () => import('@/layouts/AdminLayout.vue'),
    meta: { roles: ['company'] },
    redirect: '/company/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'company-dashboard',
        component: () => import('@/views/company/Dashboard.vue'),
        meta: { title: '公司看板', icon: 'Odometer' },
      },
      {
        path: 'employees',
        name: 'company-employees',
        component: () => import('@/views/company/Employees.vue'),
        meta: { title: '员工管理', icon: 'User' },
      },
      {
        path: 'consumptions',
        name: 'company-consumptions',
        component: () => import('@/views/company/Consumptions.vue'),
        meta: { title: '核销记录', icon: 'Tickets' },
      },
      {
        path: 'rules',
        name: 'company-rules',
        component: () => import('@/views/company/Rules.vue'),
        meta: { title: '时段规则', icon: 'Clock' },
      },
      {
        path: 'logs',
        name: 'company-logs',
        component: () => import('@/views/company/Logs.vue'),
        meta: { title: '操作日志', icon: 'Document' },
      },
      {
        path: 'settings',
        name: 'company-settings',
        component: () => import('@/views/company/Settings.vue'),
        meta: { title: '公司设置', icon: 'Setting' },
      },
    ],
  },

  { path: '/:pathMatch(.*)*', redirect: '/login' },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

/** 登录后该回哪个首页 —— 按角色分流 */
export function homeByRole(role) {
  return role === 'super' ? '/platform/dashboard' : '/company/dashboard';
}

router.beforeEach((to) => {
  document.title = to.meta?.title ? `${to.meta.title} · 团餐核销` : '团餐核销 · 管理后台';

  const user = getUser();
  const logged = isLoggedIn();

  if (to.meta?.public) {
    // 已登录还去登录页 → 直接送回各自的首页
    return logged ? homeByRole(user.role) : true;
  }

  if (!logged) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }

  const need = to.meta?.roles;
  if (need && !need.includes(user.role)) {
    // 越权访问：送回自己的首页，而不是留在空白页
    return homeByRole(user.role);
  }

  return true;
});

export default router;
