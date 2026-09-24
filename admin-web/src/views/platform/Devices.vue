<script setup>
import { ref, reactive } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { deviceApi } from '@/api/device';
import { storeApi } from '@/api/system';
import { companyApi } from '@/api/company';
import { confirmThen, fmtTime } from '@/utils/hooks';

const list = ref([]);
const loading = ref(false);

const stores = ref([]);
const companies = ref([]);

async function load() {
  loading.value = true;
  try {
    list.value = (await deviceApi.list()) || [];
  } catch {
    list.value = [];
  } finally {
    loading.value = false;
  }
}

storeApi.list().then((r) => (stores.value = r || [])).catch(() => {});
companyApi.list({ page: 1, pageSize: 100 }).then((r) => (companies.value = r?.list || [])).catch(() => {});
load();

// ── 登记 / 编辑 ──
const dialog = reactive({ visible: false, mode: 'create', submitting: false });
const formRef = ref(null);
const form = reactive({ id: '', name: '', storeId: '', companyId: '', status: 1 });

const rules = { name: [{ required: true, message: '请输入设备名称', trigger: 'blur' }] };

function openCreate() {
  dialog.mode = 'create';
  Object.assign(form, { id: '', name: '', storeId: '', companyId: '', status: 1 });
  dialog.visible = true;
}

function openEdit(row) {
  dialog.mode = 'edit';
  Object.assign(form, {
    id: row.id,
    name: row.name,
    storeId: row.storeId || '',
    companyId: row.companyId || '',
    status: row.status,
  });
  dialog.visible = true;
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  dialog.submitting = true;
  try {
    const payload = {
      name: form.name,
      storeId: form.storeId || undefined,
      companyId: form.companyId || undefined,
      status: form.status,
    };
    if (dialog.mode === 'create') {
      const res = await deviceApi.create(payload);
      dialog.visible = false;
      // 明文密钥只有这一次机会展示，必须弹出来让运营存好
      showKeyOnce(res, '设备登记成功');
    } else {
      await deviceApi.update(form.id, payload);
      ElMessage.success('已保存');
      dialog.visible = false;
    }
    load();
  } catch {
    /* 提示已统一处理 */
  } finally {
    dialog.submitting = false;
  }
}

// ── 明文密钥一次性展示 ──
const keyDialog = reactive({ visible: false, title: '', name: '', key: '', warning: '' });

function showKeyOnce(res, title) {
  keyDialog.title = title;
  keyDialog.name = res.name || '';
  keyDialog.key = res.deviceKey || '';
  keyDialog.warning = res.warning || '设备密钥仅显示这一次，请立即妥善保存';
  keyDialog.visible = true;
}

async function copyKey() {
  try {
    await navigator.clipboard.writeText(keyDialog.key);
    ElMessage.success('已复制到剪贴板');
  } catch {
    ElMessage.warning('复制失败，请手动选中复制');
  }
}

async function rotateKey(row) {
  try {
    await ElMessageBox.confirm(
      `确定要为设备「${row.name}」换发新密钥吗？换发后旧密钥立即失效，该设备需要重新配置。`,
      '换发密钥',
      { confirmButtonText: '确认换发', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  const res = await deviceApi.rotateKey(row.id);
  load();
  showKeyOnce(res, '密钥已换发');
}

async function toggleStatus(row) {
  const next = row.status === 1 ? 0 : 1;
  const word = next === 1 ? '启用' : '停用';
  await confirmThen(
    `确定要${word}设备「${row.name}」吗？`,
    async () => {
      await deviceApi.setStatus(row.id, next);
      await load();
    },
    `已${word}`,
  );
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">核销设备</h2>
        <div class="page-desc">
          设备一机一密钥。密钥只在登记 / 换发时展示一次，服务端仅存哈希 —— 丢失只能换发。
        </div>
      </div>
      <el-button type="primary" @click="openCreate">登记设备</el-button>
    </div>

    <div class="table-card">
      <el-table v-loading="loading" :data="list" empty-text="暂无数据">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="设备名称" min-width="160" show-overflow-tooltip />
        <el-table-column label="密钥前缀" width="120">
          <template #default="{ row }">
            <span class="mono">{{ row.keyPrefix || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="绑定门店" min-width="130">
          <template #default="{ row }">{{ row.storeName || '未绑定' }}</template>
        </el-table-column>
        <el-table-column label="最近使用" width="160">
          <template #default="{ row }">{{ fmtTime(row.lastUsedAt) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small">
              {{ row.status === 1 ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="warning" @click="rotateKey(row)">换发密钥</el-button>
            <el-button
              link
              :type="row.status === 1 ? 'danger' : 'success'"
              @click="toggleStatus(row)"
            >
              {{ row.status === 1 ? '停用' : '启用' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 登记 / 编辑 -->
    <el-dialog
      v-model="dialog.visible"
      :title="dialog.mode === 'create' ? '登记设备' : '编辑设备'"
      width="480px"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="设备名称" prop="name">
          <el-input v-model="form.name" placeholder="如：一楼食堂收银台" />
        </el-form-item>
        <el-form-item label="绑定门店">
          <el-select v-model="form.storeId" placeholder="不绑定则按请求门店判定" clearable style="width: 100%">
            <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="String(s.id)" />
          </el-select>
        </el-form-item>
        <el-form-item label="所属公司">
          <el-select v-model="form.companyId" placeholder="选填" clearable style="width: 100%">
            <el-option v-for="c in companies" :key="c.id" :label="c.name" :value="String(c.id)" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="dialog.mode === 'edit'" label="状态">
          <el-switch v-model="form.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>

      <el-alert
        v-if="dialog.mode === 'create'"
        type="warning"
        :closable="false"
        show-icon
        title="登记后会生成一次性明文密钥"
        description="请当场复制并配置到核销设备，关闭弹窗后无法再次查看。"
        style="margin-top: 8px"
      />

      <template #footer>
        <el-button @click="dialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="dialog.submitting" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 明文密钥（一次性） -->
    <el-dialog v-model="keyDialog.visible" :title="keyDialog.title" width="560px" :close-on-click-modal="false">
      <el-alert type="error" :closable="false" show-icon :title="keyDialog.warning" />

      <div class="key-box">
        <div class="key-label">设备：{{ keyDialog.name }}</div>
        <div class="key-value">{{ keyDialog.key }}</div>
      </div>

      <template #footer>
        <el-button @click="copyKey">复制密钥</el-button>
        <el-button type="primary" @click="keyDialog.visible = false">我已保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.key-box {
  margin-top: 16px;
  background: #f7f9fb;
  border: 1px solid var(--tc-border);
  border-radius: 8px;
  padding: 16px;
}

.key-label {
  font-size: 13px;
  color: var(--tc-text-sub);
  margin-bottom: 10px;
}

.key-value {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 15px;
  color: var(--tc-primary);
  word-break: break-all;
  line-height: 1.7;
  user-select: all;
}
</style>
