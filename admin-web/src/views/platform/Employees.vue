<script setup>
import { ref, reactive, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { platformEmployeeApi } from '@/api/employee';
import { companyApi } from '@/api/company';
import { useList, confirmThen, fmtTime } from '@/utils/hooks';

const { list, total, loading, page, size, filters, search, reset, onPageChange, onSizeChange, reloadAfterMutation } =
  useList((params) => platformEmployeeApi.list(params), {
    pageSize: 20,
    defaultFilters: { keyword: '', companyId: '', status: '' },
  });

const companies = ref([]);
companyApi
  .list({ page: 1, pageSize: 100 })
  .then((r) => (companies.value = r?.list || []))
  .catch(() => {});

// ── 新增 / 编辑 ──
const dialog = reactive({ visible: false, mode: 'create', submitting: false });
const formRef = ref(null);
const form = reactive({ id: '', companyId: '', name: '', phone: '', employeeNo: '', status: 1 });

const rules = {
  companyId: [{ required: true, message: '请选择所属公司', trigger: 'change' }],
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  phone: [{ required: true, message: '请输入手机号', trigger: 'blur' }],
};

function openCreate() {
  dialog.mode = 'create';
  Object.assign(form, { id: '', companyId: '', name: '', phone: '', employeeNo: '', status: 1 });
  dialog.visible = true;
}

function openEdit(row) {
  dialog.mode = 'edit';
  Object.assign(form, {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    phone: row.phone,
    employeeNo: row.employeeNo || '',
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
      companyId: form.companyId,
      name: form.name,
      phone: form.phone,
      employeeNo: form.employeeNo || undefined,
      status: form.status,
    };
    if (dialog.mode === 'create') {
      await platformEmployeeApi.create(payload);
      ElMessage.success('员工已创建');
    } else {
      await platformEmployeeApi.update(form.id, payload);
      ElMessage.success('已保存');
    }
    dialog.visible = false;
    search();
  } catch {
    /* 提示已统一处理 */
  } finally {
    dialog.submitting = false;
  }
}

async function toggleStatus(row) {
  const next = row.status === 1 ? 0 : 1;
  const word = next === 1 ? '启用' : '停用';
  await confirmThen(`确定要${word}员工「${row.name}」吗？`, async () => {
    await platformEmployeeApi.setStatus(row.id, next);
    await reloadAfterMutation();
  }, `已${word}`);
}

/**
 * 解绑员工微信。
 *
 * 员工换微信后，新微信登录一定会被「该员工账号已绑定其他微信」拦住，
 * 只能由后台解开 —— 公司管理员在自己后台也能做，平台侧留一个入口
 * 是为了处理客户找上来的情况。
 *
 * 解绑 ≠ 停用：不动额度、不动账号状态、不动历史记录，
 * 只解除微信关联并让该员工重新登录一次。
 */
async function unbindWechat(row) {
  await confirmThen(
    `确定解绑「${row.name}」的微信吗？解绑后该员工手机上会立即退出登录，` +
      `需要用本人手机号重新绑定微信才能继续核销。核销次数与历史记录不受影响。`,
    async () => {
      await platformEmployeeApi.unbindWechat(row.id);
      await reloadAfterMutation();
    },
    '已解绑',
  );
}

// ── 批量导入 ──
const batch = reactive({ visible: false, submitting: false, text: '', result: null });

const parsedRows = computed(() => {
  return batch.text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      // 支持「姓名,手机号,工号」逗号/制表符分隔，工号可省
      const parts = line.split(/[,，\t]/).map((s) => s.trim());
      return { name: parts[0], phone: parts[1], employeeNo: parts[2] || undefined };
    });
});

function openBatch() {
  batch.text = '';
  batch.result = null;
  batch.visible = true;
}

async function submitBatch() {
  if (!batch.companyId) {
    ElMessage.warning('请先选择所属公司');
    return;
  }
  if (!parsedRows.value.length) {
    ElMessage.warning('请至少输入一行数据');
    return;
  }
  if (parsedRows.value.length > 2000) {
    ElMessage.warning('单次导入不能超过 2000 行');
    return;
  }

  batch.submitting = true;
  try {
    // 后端逐行容错：个别行失败不回滚整批，所以这里必然拿到明细结果
    const res = await platformEmployeeApi.batch(
      parsedRows.value.map((r) => ({ ...r, companyId: batch.companyId })),
    );
    batch.result = res;
    ElMessage.success(`导入完成：成功 ${res.success ?? 0} 条，失败 ${res.failed ?? 0} 条`);
    if ((res.failed ?? 0) === 0) {
      batch.visible = false;
      search();
    }
  } catch {
    /* 提示已统一处理 */
  } finally {
    batch.submitting = false;
  }
}

function afterBatchClose() {
  search();
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">员工管理</h2>
        <div class="page-desc">全平台员工，共 {{ total }} 人</div>
      </div>
      <div>
        <el-button @click="openBatch">批量导入</el-button>
        <el-button type="primary" @click="openCreate">新增员工</el-button>
      </div>
    </div>

    <div class="filter-bar">
      <el-input
        v-model="filters.keyword"
        placeholder="姓名 / 手机号 / 工号"
        clearable
        style="width: 220px"
        @keyup.enter="search"
        @clear="search"
      />
      <el-select v-model="filters.companyId" placeholder="全部公司" clearable style="width: 200px">
        <el-option v-for="c in companies" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-select v-model="filters.status" placeholder="全部状态" clearable style="width: 130px">
        <el-option label="启用" :value="1" />
        <el-option label="停用" :value="0" />
      </el-select>
      <el-button type="primary" @click="search">查询</el-button>
      <el-button @click="reset">重置</el-button>
    </div>

    <div class="table-card">
      <el-table v-loading="loading" :data="list" empty-text="暂无数据">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="姓名" width="110" />
        <el-table-column label="公司" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.companyName || '—' }}</template>
        </el-table-column>
        <el-table-column prop="phone" label="手机号" width="130" />
        <el-table-column label="工号" width="110">
          <template #default="{ row }">{{ row.employeeNo || '—' }}</template>
        </el-table-column>
        <el-table-column label="核销次数" width="100" align="right">
          <template #default="{ row }">{{ row.consumptionCount ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="微信" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.bound ? 'success' : 'info'" size="small">
              {{ row.bound ? '已绑定' : '未绑定' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small">
              {{ row.status === 1 ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <!-- 未绑定时置灰：点了也只会收到「尚未绑定微信」的报错 -->
            <el-button link type="warning" :disabled="!row.bound" @click="unbindWechat(row)">
              解绑微信
            </el-button>
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

      <div class="table-pager">
        <el-pagination
          :current-page="page"
          :page-size="size"
          :total="total"
          :page-sizes="[10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @current-change="onPageChange"
          @size-change="onSizeChange"
        />
      </div>
    </div>

    <!-- 新增 / 编辑 -->
    <el-dialog
      v-model="dialog.visible"
      :title="dialog.mode === 'create' ? '新增员工' : '编辑员工'"
      width="480px"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="所属公司" prop="companyId">
          <el-select v-model="form.companyId" placeholder="请选择公司" style="width: 100%">
            <el-option v-for="c in companies" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="姓名" prop="name">
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="手机号" prop="phone">
          <el-input v-model="form.phone" />
        </el-form-item>
        <el-form-item label="工号">
          <el-input v-model="form.employeeNo" placeholder="选填" />
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="form.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="dialog.submitting" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 批量导入 -->
    <el-dialog
      v-model="batch.visible"
      title="批量导入员工"
      width="620px"
      @closed="afterBatchClose"
    >
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="每行一个员工，格式：姓名,手机号[,工号]"
        description="逐行校验，个别行失败不会影响其他行 —— 导入后可查看失败明细单独修补。"
        style="margin-bottom: 16px"
      />

      <el-form label-width="90px">
        <el-form-item label="所属公司" required>
          <el-select v-model="batch.companyId" placeholder="请选择公司" style="width: 100%">
            <el-option v-for="c in companies" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
      </el-form>

      <el-input
        v-model="batch.text"
        type="textarea"
        :rows="8"
        placeholder="张三,13800000001,EMP001&#10;李四,13800000002&#10;王五,13800000003,EMP003"
      />

      <div class="batch-hint">
        已识别 <strong>{{ parsedRows.length }}</strong> 行
        <span v-if="parsedRows.length > 2000" class="danger">（超过 2000 行上限）</span>
      </div>

      <div v-if="batch.result" class="batch-result">
        <div class="batch-result-head">
          导入结果：成功 {{ batch.result.success ?? 0 }} 条，失败 {{ batch.result.failed ?? 0 }} 条
        </div>
        <el-table
          v-if="batch.result.errors?.length"
          :data="batch.result.errors"
          size="small"
          max-height="220"
        >
          <el-table-column prop="row" label="行号" width="70" />
          <el-table-column prop="name" label="姓名" width="100" />
          <el-table-column prop="reason" label="失败原因" min-width="200" show-overflow-tooltip />
        </el-table>
      </div>

      <template #footer>
        <el-button @click="batch.visible = false">关闭</el-button>
        <el-button type="primary" :loading="batch.submitting" @click="submitBatch">开始导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.batch-hint {
  margin-top: 10px;
  font-size: 13px;
  color: var(--tc-text-sub);
}

.batch-hint .danger {
  color: #e53e3e;
}

.batch-result {
  margin-top: 16px;
}

.batch-result-head {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
</style>
