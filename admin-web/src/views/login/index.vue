<script setup>
import { ref, reactive } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useUserStore } from '@/stores/user';
import { homeByRole } from '@/router';

const router = useRouter();
const route = useRoute();
const store = useUserStore();

const formRef = ref(null);
const loading = ref(false);
const errorMsg = ref('');

const form = reactive({
  username: '',
  password: '',
});

const rules = {
  username: [{ required: true, message: '请输入账号', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
};

async function onSubmit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  loading.value = true;
  errorMsg.value = '';
  try {
    const user = await store.login({ username: form.username, password: form.password });
    ElMessage.success('登录成功');
    const target = route.query.redirect || homeByRole(user.role);
    router.replace(target);
  } catch (e) {
    // 后端对连续失败做了限流（10 次/5 分钟），错误文案直接透传即可
    errorMsg.value = e.message || '登录失败';
  } finally {
    loading.value = false;
  }
}

/** 演示环境便捷填充 —— 对应后端种子账号 */
function fill(username, password) {
  form.username = username;
  form.password = password;
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-head">
        <div class="logo">团</div>
        <h1 class="title">团餐核销系统</h1>
        <p class="subtitle">管理后台 · 公司端 / 平台端</p>
      </div>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        @submit.prevent="onSubmit"
      >
        <el-form-item label="账号" prop="username">
          <el-input
            v-model="form.username"
            placeholder="请输入账号"
            size="large"
            autocomplete="username"
          />
        </el-form-item>

        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="请输入密码"
            size="large"
            show-password
            autocomplete="current-password"
            @keyup.enter="onSubmit"
          />
        </el-form-item>

        <el-alert
          v-if="errorMsg"
          :title="errorMsg"
          type="error"
          :closable="false"
          show-icon
          class="err"
        />

        <el-button
          type="primary"
          size="large"
          class="submit"
          :loading="loading"
          @click="onSubmit"
        >
          登录
        </el-button>
      </el-form>

      <div class="demo">
        <span class="demo-label">种子账号：</span>
        <el-link type="primary" :underline="false" @click="fill('admin', 'admin123456')">
          平台超管
        </el-link>
        <el-divider direction="vertical" />
        <el-link type="primary" :underline="false" @click="fill('company_a', 'company123456')">
          公司管理员
        </el-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-wrap {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #2b6cb0 0%, #4299e1 55%, #63b3ed 100%);
}

.login-card {
  width: 400px;
  background: #fff;
  border-radius: 14px;
  padding: 40px 36px 28px;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.2);
}

.login-head {
  text-align: center;
  margin-bottom: 26px;
}

.logo {
  width: 52px;
  height: 52px;
  border-radius: 12px;
  background: var(--tc-primary);
  color: #fff;
  font-size: 24px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 14px;
}

.title {
  font-size: 21px;
  font-weight: 600;
  margin: 0;
}

.subtitle {
  font-size: 13px;
  color: var(--tc-text-sub);
  margin: 6px 0 0;
}

.err {
  margin-bottom: 14px;
}

.submit {
  width: 100%;
}

.demo {
  margin-top: 18px;
  text-align: center;
  font-size: 12px;
}

.demo-label {
  color: #9ca3af;
}
</style>
