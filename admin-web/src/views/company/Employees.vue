<script setup>
import { computed, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { companyEmployeeApi } from '@/api/employee';
import { useList, confirmThen } from '@/utils/hooks';

const {
  list,
  total,
  loading,
  page,
  size,
  filters,
  search,
  reset,
  onPageChange,
  onSizeChange,
  reloadAfterMutation,
} = useList((params) => companyEmployeeApi.list(params), {
  pageSize: 20,
  defaultFilters: { keyword: '', status: '' },
});

const detail = ref(null);
const detailVisible = ref(false);

const selected = ref([]);

function openDetail(row) {
  detail.value = row;
  detailVisible.value = true;
}

function onSelectionChange(rows) {
  selected.value = rows;
}

/**
 * 公司端唯一的写操作：停用 / 启用。
 * 公司管理员不能新增或删除员工 —— 增删只在平台端，避免客户自行扩容绕过配额。
 */
async function toggleStatus(row) {
  const next = row.status === 1 ? 0 : 1;
  const word = next === 1 ? '启用' : '停用';
  await confirmThen(
    next === 1
      ? `确定要启用员工「${row.name}」吗？启用后该员工可以正常核销。`
      : `确定要停用员工「${row.name}」吗？停用后该员工将无法核销，但历史记录会保留。`,
    async () => {
      await companyEmployeeApi.setStatus(row.id, next);
      await reloadAfterMutation();
    },
    `已${word}`,
  );
}

// ─────────────────────────────────────────────
// 解绑微信
// ─────────────────────────────────────────────

/**
 * 解绑员工微信。
 *
 * 这是公司端解决「员工换微信」的唯一出口：员工拿新微信登录时会被
 * 「该员工账号已绑定其他微信，请联系公司管理员」拦住，
 * 没有这个按钮，管理员只能找平台改库 —— 而换手机是最普通不过的事。
 *
 * 解绑 ≠ 停用：额度、账号状态、历史记录一概不动，
 * 只解除微信关联并让该员工重新登录一次。
 */
async function unbindWechat(row) {
  await confirmThen(
    `确定解绑「${row.name}」的微信吗？解绑后该员工手机上会立即退出登录，` +
      `需要用本人手机号重新绑定微信才能继续核销。核销次数与历史记录不受影响。`,
    async () => {
      await companyEmployeeApi.unbindWechat(row.id);
      await reloadAfterMutation();
    },
    '已解绑',
  );
}

// ─────────────────────────────────────────────
// 剩余次数设置
// ─────────────────────────────────────────────

/**
 * 三种语义必须清晰区分，弹窗里用「不限」开关来表达：
 * - 不限   → 传 null
 * - 0 次   → 传 0（可以，表示一次都不允许）
 * - N 次   → 传正整数
 * 「不限」不能靠"不传"来表达 —— 后端会当成缺参数报 400。
 */
const quotaVisible = ref(false);
const quotaMode = ref('single'); // single | batch
const quotaTarget = ref(null); // 单个模式下的员工行
const quotaSubmitting = ref(false);

const quotaForm = reactive({
  unlimited: false,
  quotaTotal: 10,
  resetUsed: false,
});

const quotaTitle = computed(() =>
  quotaMode.value === 'single'
    ? `设置「${quotaTarget.value?.name ?? ''}」的核销次数`
    : `批量设置 ${selected.value.length} 名员工的核销次数`,
);

/** 已用次数提示：单人模式下展示，避免管理员误把「总额度」当成「剩余」 */
const quotaHint = computed(() => {
  if (quotaMode.value !== 'single' || !quotaTarget.value) return '';
  const used = quotaTarget.value.quotaUsed ?? 0;
  if (quotaForm.unlimited) return `该员工已核销 ${used} 次。设为「不限」后不再受个人次数限制。`;
  const remain = Math.max(0, Number(quotaForm.quotaTotal || 0) - used);
  return `该员工已核销 ${used} 次，设置后剩余 ${remain} 次。`;
});

function openQuota(row) {
  quotaMode.value = 'single';
  quotaTarget.value = row;
  // 回填当前值：不限时开关打开，否则填当前总额度
  quotaForm.unlimited = row.quotaTotal === null || row.quotaTotal === undefined;
  quotaForm.quotaTotal = row.quotaTotal ?? 10;
  quotaForm.resetUsed = false;
  quotaVisible.value = true;
}

function openBatchQuota() {
  if (!selected.value.length) {
    ElMessage.warning('请先勾选要设置的员工');
    return;
  }
  quotaMode.value = 'batch';
  quotaTarget.value = null;
  quotaForm.unlimited = false;
  quotaForm.quotaTotal = 10;
  quotaForm.resetUsed = false;
  quotaVisible.value = true;
}

async function submitQuota() {
  const payload = quotaForm.unlimited ? null : Number(quotaForm.quotaTotal);

  if (!quotaForm.unlimited) {
    if (!Number.isInteger(payload)) {
      ElMessage.warning('请输入整数次数');
      return;
    }
    if (payload < 0) {
      ElMessage.warning('次数不能为负数');
      return;
    }
  }

  quotaSubmitting.value = true;
  try {
    if (quotaMode.value === 'single') {
      await companyEmployeeApi.setQuota(quotaTarget.value.id, payload, quotaForm.resetUsed);
    } else {
      await companyEmployeeApi.batchSetQuota(
        selected.value.map((r) => r.id),
        payload,
      );
    }
    ElMessage.success('设置成功');
    quotaVisible.value = false;
    await reloadAfterMutation();
  } catch {
    // request.js 已弹出具体错误
  } finally {
    quotaSubmitting.value = false;
  }
}

/** 剩余次数展示：null 统一显示「不限」 */
function remainText(row) {
  const totalQ = row.quotaTotal;
  if (totalQ === null || totalQ === undefined) return '不限';
  return `${row.quotaRemain ?? 0} / ${totalQ}`;
}

function remainTagType(row) {
  const totalQ = row.quotaTotal;
  if (totalQ === null || totalQ === undefined) return 'info';
  return (row.quotaRemain ?? 0) > 0 ? 'success' : 'danger';
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">员工管理</h2>
        <div class="page-desc">
          本公司员工，共 {{ total }} 人。可设置每人剩余核销次数、解绑已绑定的微信；如需新增或删除员工，请联系平台管理员。
        </div>
      </div>
    </div>

    <div class="filter-bar">
      <el-input
        v-model="filters.keyword"
        placeholder="姓名 / 手机号 / 工号"
        clearable
        style="width: 240px"
        @keyup.enter="search"
        @clear="search"
      />
      <el-select v-model="filters.status" placeholder="全部状态" clearable style="width: 130px">
        <el-option label="启用" :value="1" />
        <el-option label="停用" :value="0" />
      </el-select>
      <el-button type="primary" @click="search">查询</el-button>
      <el-button @click="reset">重置</el-button>
      <el-button type="primary" plain :disabled="!selected.length" @click="openBatchQuota">
        批量设置次数{{ selected.length ? `（${selected.length}）` : '' }}
      </el-button>
    </div>

    <div class="table-card">
      <el-table
        v-loading="loading"
        :data="list"
        empty-text="暂无数据"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="46" />
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="姓名" width="110" />
        <el-table-column prop="phone" label="手机号" width="130" />
        <el-table-column label="工号" width="120">
          <template #default="{ row }">{{ row.employeeNo || '—' }}</template>
        </el-table-column>
        <el-table-column label="已核销" width="90" align="right">
          <template #default="{ row }">{{ row.consumptionCount ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="剩余次数" width="120" align="center">
          <template #default="{ row }">
            <el-tag :type="remainTagType(row)" size="small">{{ remainText(row) }}</el-tag>
          </template>
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
        <el-table-column label="操作" width="270" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button link type="primary" @click="openQuota(row)">设置次数</el-button>
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

    <el-drawer v-model="detailVisible" title="员工详情" size="380px">
      <el-descriptions v-if="detail" :column="1" border size="small">
        <el-descriptions-item label="ID">{{ detail.id }}</el-descriptions-item>
        <el-descriptions-item label="姓名">{{ detail.name }}</el-descriptions-item>
        <el-descriptions-item label="手机号">{{ detail.phone }}</el-descriptions-item>
        <el-descriptions-item label="工号">{{ detail.employeeNo || '未设置' }}</el-descriptions-item>
        <el-descriptions-item label="累计核销">
          {{ detail.consumptionCount ?? 0 }} 次
        </el-descriptions-item>
        <el-descriptions-item label="剩余次数">
          {{ remainText(detail) }}
        </el-descriptions-item>
        <el-descriptions-item label="微信绑定">
          <el-tag :type="detail.bound ? 'success' : 'info'" size="small">
            {{ detail.bound ? '已绑定' : '未绑定' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="detail.status === 1 ? 'success' : 'info'" size="small">
            {{ detail.status === 1 ? '启用' : '停用' }}
          </el-tag>
        </el-descriptions-item>
      </el-descriptions>
    </el-drawer>

    <el-dialog v-model="quotaVisible" :title="quotaTitle" width="440px">
      <el-form label-width="90px">
        <el-form-item label="不限次数">
          <el-switch v-model="quotaForm.unlimited" />
          <span class="quota-switch-hint">开启后该员工不再受个人次数限制</span>
        </el-form-item>
        <el-form-item v-if="!quotaForm.unlimited" label="核销次数">
          <el-input-number v-model="quotaForm.quotaTotal" :min="0" :max="100000" :step="1" />
        </el-form-item>
        <el-form-item v-if="quotaMode === 'single' && !quotaForm.unlimited" label="清零已用">
          <el-checkbox v-model="quotaForm.resetUsed">同时把「已核销次数」清零</el-checkbox>
        </el-form-item>
        <el-form-item v-if="quotaHint">
          <span class="quota-hint">{{ quotaHint }}</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="quotaVisible = false">取消</el-button>
        <el-button type="primary" :loading="quotaSubmitting" @click="submitQuota">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.quota-switch-hint {
  margin-left: 10px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.quota-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
}
</style>
