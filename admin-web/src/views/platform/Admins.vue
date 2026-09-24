<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { adminApi } from '@/api/system';
import { companyApi } from '@/api/company';
import { useUserStore } from '@/stores/user';
import { fmtTime } from '@/utils/hooks';

const store = useUserStore();
const list = ref([]);
const loading = ref(false);
const companies = ref([]);

async function load() {
  loading.value = true;
  try {
    list.value = (await adminApi.list()) || [];
  } catch {
    list.value = [];
  } finally {
    loading.value = false;
  }
}

companyApi
  .list({ page: 1, pageSize: 100 })
  .then((r) => (companies.value = r?.list || []))
  .catch(() => {});
onMounted(load);

/** 启用中的超管数量 —— 用于前端提示"最后一个超管不可停用" */
const activeSupers = computed(() => list.value.filter((a) => a.role === 'super' && a.status === 1));

const roleOptions = [
  { label: '平台超管', value: 'super' },
  { label: '公司管理员', value: 'company' },
];

// ── 新增 ──
const createDialog = reactive({ visible: false, submitting: false });
const createFormRef = ref(null);
const createForm = reactive({ username: '', password: '', role: 'company', companyId: '' });

const createRules = {
  username: [
    { required: true, message: '请输入账号', trigger: 'blur' },
    { min: 3, max: 50, message: '账号长度需在 3-50 个字符之间', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
  role: [{ required: true, message: '请选择角色', trigger: 'change' }],
};

function openCreate() {
  Object.assign(createForm, { username: '', password: '', role: 'company', companyId: '' });
  createDialog.visible = true;
}

async function submitCreate() {
  const valid = await createFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  if (createForm.role === 'company' && !createForm.companyId) {
    ElMessage.warning('公司管理员必须指定所属公司');
    return;
  }
  createDialog.submitting = true;
  try {
    await adminApi.create({
      username: createForm.username,
      password: createForm.password,
      role: createForm.role,
      companyId: createForm.role === 'company' ? createForm.companyId : undefined,
    });
    ElMessage.success('账号已创建');
    createDialog.visible = false;
    load();
  } catch {
    /* 提示已统一处理 */
  } finally {
    createDialog.submitting = false;
  }
}

// ── 改密 ──
const pwdDialog = reactive({ visible: false, submitting: false, id: '', username: '' });
const pwdFormRef = ref(null);
const pwdForm = reactive({ password: '' });
const pwdRules = {
  password: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
};

function openPwd(row) {
  pwdDialog.id = row.id;
  pwdDialog.username = row.username;
  pwdForm.password = '';
  pwdDialog.visible = true;
}

async function submitPwd() {
  const valid = await pwdFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  pwdDialog.submitting = true;
  try {
    await adminApi.changePassword(pwdDialog.id, pwdForm.password);
    ElMessage.success('密码已重置，该账号的旧登录态已全部失效');
    pwdDialog.visible = false;
    load();
  } catch {
    /* 提示已统一处理 */
  } finally {
    pwdDialog.submitting = false;
  }
}

// ── 停用 / 启用 ──
async function toggleStatus(row) {
  const next = row.status === 1 ? 0 : 1;
  const word = next === 1 ? '启用' : '停用';

  if (row.isSelf) {
    ElMessage.warning('不能停用当前登录的账号');
    return;
  }
  if (next === 0 && row.role === 'super' && activeSupers.value.length <= 1) {
    ElMessage.warning('这是最后一个启用中的超管，停用后将无人可管理系统');
    return;
  }

  try {
    await ElMessageBox.confirm(`确定要${word}账号「${row.username}」吗？`, `${word}账号`, {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }

  await adminApi.setStatus(row.id, next);
  ElMessage.success(`已${word}`);
  load();
}

// ── 删除 ──
async function remove(row) {
  if (row.isSelf) {
    ElMessage.warning('不能删除当前登录的账号');
    return;
  }
  if (row.role === 'super' && activeSupers.value.length <= 1) {
    ElMessage.warning('这是最后一个超管，删除后将无人可管理系统');
    return;
  }

  try {
    await ElMessageBox.confirm(
      `确定要删除账号「${row.username}」吗？此操作不可撤销。`,
      '删除账号',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'error' },
    );
  } catch {
    return;
  }

  await adminApi.remove(row.id);
  ElMessage.success('已删除');
  load();
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">后台账号</h2>
        <div class="page-desc">
          系统保证任何情况下都至少保留一个启用中的超管。改密 / 停用 / 删除会立即使该账号的旧登录态失效。
        </div>
      </div>
      <el-button type="primary" @click="openCreate">新增账号</el-button>
    </div>

    <div class="table-card">
      <el-table v-loading="loading" :data="list" empty-text="暂无数据">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="账号" min-width="150">
          <template #default="{ row }">
            {{ row.username }}
            <el-tag v-if="row.isSelf" size="small" type="primary" effect="plain" style="margin-left: 6px">
              当前登录
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="130">
          <template #default="{ row }">
            <el-tag :type="row.role === 'super' ? 'danger' : 'primary'" size="small" effect="light">
              {{ row.role === 'super' ? '平台超管' : '公司管理员' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="所属公司" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.companyName || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small">
              {{ row.status === 1 ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openPwd(row)">重置密码</el-button>
            <el-button
              link
              :type="row.status === 1 ? 'danger' : 'success'"
              :disabled="row.isSelf"
              @click="toggleStatus(row)"
            >
              {{ row.status === 1 ? '停用' : '启用' }}
            </el-button>
            <el-button link type="danger" :disabled="row.isSelf" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 新增 -->
    <el-dialog v-model="createDialog.visible" title="新增后台账号" width="460px">
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="90px">
        <el-form-item label="账号" prop="username">
          <el-input v-model="createForm.username" placeholder="3-50 个字符" />
        </el-form-item>
        <el-form-item label="初始密码" prop="password">
          <el-input v-model="createForm.password" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-radio-group v-model="createForm.role">
            <el-radio v-for="r in roleOptions" :key="r.value" :value="r.value">
              {{ r.label }}
            </el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="createForm.role === 'company'" label="所属公司">
          <el-select v-model="createForm.companyId" placeholder="请选择公司" style="width: 100%">
            <el-option v-for="c in companies" :key="c.id" :label="c.name" :value="String(c.id)" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="createDialog.submitting" @click="submitCreate">
          创建
        </el-button>
      </template>
    </el-dialog>

    <!-- 重置密码 -->
    <el-dialog v-model="pwdDialog.visible" title="重置密码" width="420px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        :title="`将为账号「${pwdDialog.username}」设置新密码`"
        description="保存后该账号在所有设备上的登录态会立即失效，需要重新登录。"
        style="margin-bottom: 16px"
      />
      <el-form ref="pwdFormRef" :model="pwdForm" :rules="pwdRules" label-width="80px">
        <el-form-item label="新密码" prop="password">
          <el-input v-model="pwdForm.password" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="pwdDialog.submitting" @click="submitPwd">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
