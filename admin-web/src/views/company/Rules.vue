<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { companyRuleApi } from '@/api/rule';
import { confirmThen, fmtTime } from '@/utils/hooks';

const list = ref([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    list.value = (await companyRuleApi.list()) || [];
  } catch {
    list.value = [];
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const dialog = reactive({ visible: false, mode: 'create', submitting: false });
const formRef = ref(null);
const form = reactive({ id: '', name: '', perEmployeeLimit: 1, status: 1 });
const timeRange = ref(['11:30', '13:00']);

const rules = { name: [{ required: true, message: '请输入规则名称', trigger: 'blur' }] };

/** end < start 即跨天，例如 22:00 - 01:00 */
const isCrossDay = computed(() => {
  const [s, e] = timeRange.value || [];
  return Boolean(s && e && e < s);
});

function openCreate() {
  dialog.mode = 'create';
  Object.assign(form, { id: '', name: '', perEmployeeLimit: 1, status: 1 });
  timeRange.value = ['11:30', '13:00'];
  dialog.visible = true;
}

function openEdit(row) {
  dialog.mode = 'edit';
  Object.assign(form, {
    id: row.id,
    name: row.name,
    perEmployeeLimit: row.perEmployeeLimit,
    status: row.status,
  });
  timeRange.value = [row.startTime, row.endTime];
  dialog.visible = true;
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  const [startTime, endTime] = timeRange.value || [];
  if (!startTime || !endTime) {
    ElMessage.warning('请选择时段');
    return;
  }

  dialog.submitting = true;
  try {
    const payload = {
      name: form.name,
      startTime,
      endTime,
      perEmployeeLimit: Number(form.perEmployeeLimit) || 0,
      status: form.status,
    };
    if (dialog.mode === 'create') {
      await companyRuleApi.create(payload);
      ElMessage.success('规则已创建');
    } else {
      await companyRuleApi.update(form.id, payload);
      ElMessage.success('已保存');
    }
    dialog.visible = false;
    load();
  } catch {
    /* 提示已统一处理 */
  } finally {
    dialog.submitting = false;
  }
}

async function toggleStatus(row) {
  const next = row.status === 1 ? 0 : 1;
  const word = next === 1 ? '启用' : '停用';
  await confirmThen(
    `确定要${word}规则「${row.name}」吗？`,
    async () => {
      await companyRuleApi.setStatus(row.id, next);
      await load();
    },
    `已${word}`,
  );
}

async function remove(row) {
  await confirmThen(
    `确定要删除规则「${row.name}」吗？删除后该时段将不再限制核销。`,
    async () => {
      await companyRuleApi.remove(row.id);
      await load();
    },
    '已删除',
    '删除规则',
  );
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">时段规则</h2>
        <div class="page-desc">
          设置员工可核销的时间段。不设置任何规则 = 全天不限时段。
        </div>
      </div>
      <el-button type="primary" @click="openCreate">新增规则</el-button>
    </div>

    <el-alert
      v-if="list.length > 1"
      type="info"
      :closable="false"
      show-icon
      title="存在多条规则时取最宽松的一条"
      description="例如同时设置了「每人限 1 次」和「不限次数」，以不限次数为准。"
      style="margin-bottom: 16px"
    />

    <div class="table-card">
      <el-table v-loading="loading" :data="list" empty-text="未设置规则，当前全天不限时段">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="规则名称" min-width="150" />
        <el-table-column label="时段" width="200">
          <template #default="{ row }">
            <span class="mono">{{ row.startTime }} - {{ row.endTime }}</span>
            <el-tag v-if="row.crossDay" size="small" type="warning" effect="light" style="margin-left: 8px">
              跨天
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="每人限次" width="110" align="right">
          <template #default="{ row }">
            {{ row.perEmployeeLimit === 0 ? '不限' : `${row.perEmployeeLimit} 次` }}
          </template>
        </el-table-column>
        <el-table-column label="当前状态" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.status === 0" size="small" type="info">已停用</el-tag>
            <el-tag v-else-if="row.active" size="small" type="success">进行中</el-tag>
            <el-tag v-else size="small" type="info">未开始</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button
              link
              :type="row.status === 1 ? 'danger' : 'success'"
              @click="toggleStatus(row)"
            >
              {{ row.status === 1 ? '停用' : '启用' }}
            </el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog
      v-model="dialog.visible"
      :title="dialog.mode === 'create' ? '新增时段规则' : '编辑时段规则'"
      width="500px"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="规则名称" prop="name">
          <el-input v-model="form.name" placeholder="如：午餐、晚餐、夜宵" />
        </el-form-item>
        <el-form-item label="时段">
          <el-time-picker
            v-model="timeRange"
            is-range
            value-format="HH:mm"
            format="HH:mm"
            range-separator="至"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="每人限次">
          <el-input-number v-model="form.perEmployeeLimit" :min="0" style="width: 100%" />
          <div class="hint">填 0 表示该时段不限次数</div>
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="form.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>

      <el-alert
        v-if="isCrossDay"
        type="warning"
        :closable="false"
        show-icon
        title="这是跨天时段"
        description="结束时间早于开始时间，表示跨越零点。例如 22:00 至 01:00 表示当晚 22 点到次日凌晨 1 点。"
      />

      <template #footer>
        <el-button @click="dialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="dialog.submitting" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.hint {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 4px;
}
</style>
