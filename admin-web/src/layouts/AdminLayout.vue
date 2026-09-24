<script setup>
import { computed, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { useUserStore } from '@/stores/user';
import { homeByRole } from '@/router';

const router = useRouter();
const route = useRoute();
const store = useUserStore();

const collapsed = ref(false);

/** 从当前路由的匹配链里取子路由作为菜单项 */
const menus = computed(() => {
  const base = store.isSuper ? '/platform' : '/company';
  const matched = router.getRoutes().filter((r) => r.path.startsWith(base + '/') && r.meta?.title);
  return matched.map((r) => ({
    path: r.path,
    title: r.meta.title,
    icon: r.meta.icon,
  }));
});

const activeMenu = computed(() => route.path);

const roleText = computed(() => (store.isSuper ? '平台总后台' : '公司后台'));

function go(path) {
  if (path !== route.path) router.push(path);
}

async function onLogout() {
  try {
    await ElMessageBox.confirm('确定要退出登录吗？', '退出登录', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return; // 用户取消
  }
  store.logout();
  router.replace('/login');
}
</script>

<template>
  <el-container class="layout">
    <el-aside :width="collapsed ? '64px' : '220px'" class="aside">
      <div class="brand">
        <span class="brand-mark">团</span>
        <span v-show="!collapsed" class="brand-text">团餐核销</span>
      </div>

      <el-menu
        :default-active="activeMenu"
        :collapse="collapsed"
        :collapse-transition="false"
        class="menu"
        @select="go"
      >
        <el-menu-item v-for="m in menus" :key="m.path" :index="m.path">
          <span class="menu-dot"></span>
          <template #title>{{ m.title }}</template>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="header-left">
          <el-button text @click="collapsed = !collapsed">
            {{ collapsed ? '展开' : '收起' }}
          </el-button>
          <span class="crumb">{{ route.meta?.title || '' }}</span>
        </div>

        <div class="header-right">
          <el-tag size="small" :type="store.isSuper ? 'danger' : 'primary'" effect="light">
            {{ roleText }}
          </el-tag>
          <span class="who">{{ store.displayName }}</span>
          <el-dropdown @command="(c) => c === 'logout' && onLogout()">
            <el-button text>账号 ▾</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="home" @click="go(homeByRole(store.role))">
                  返回首页
                </el-dropdown-item>
                <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100vh;
}

.aside {
  background: #1f2d3d;
  transition: width 0.2s;
  overflow-x: hidden;
}

.brand {
  height: 60px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 18px;
  color: #fff;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  white-space: nowrap;
}

.brand-mark {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: var(--tc-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  flex-shrink: 0;
}

.brand-text {
  font-size: 15px;
  font-weight: 600;
}

.menu {
  border-right: none;
  background: transparent;
}

.menu :deep(.el-menu-item) {
  color: #c3ccd8;
}

.menu :deep(.el-menu-item:hover) {
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
}

.menu :deep(.el-menu-item.is-active) {
  background: var(--tc-primary);
  color: #fff;
}

.menu-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  margin-right: 10px;
  flex-shrink: 0;
  opacity: 0.7;
}

.header {
  background: #fff;
  border-bottom: 1px solid var(--tc-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.crumb {
  font-size: 15px;
  font-weight: 600;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.who {
  font-size: 14px;
}

.main {
  background: var(--tc-bg);
  padding: 20px;
  overflow-y: auto;
}
</style>
