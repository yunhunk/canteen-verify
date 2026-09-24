<script setup>
import { ref, reactive, onMounted } from 'vue';
import { logApi } from '@/api/system';
import { companyApi } from '@/api/company';
import { useList, fmtTime, rangeToParams } from '@/utils/hooks';

const companies = ref([]);
const dateRange = ref([]);

const { list, total, loading, page, size, filters, load, search, reset, onPageChange, onSizeChange } =
  useList(
    (params) => {
      const { startDate, endDate } = rangeToParams(dateRange.value);
      return logApi.platform({ ...params, startDate, endDate });
    },
    {
      pageSize: 20,
      immediate: false,
      // '__PLATFORM__' 是后端约定的"只看平台级操作（company_id 为空）"哨兵值
      defaultFilters: { companyId: '', module: '', action: '' },
    },
  );

const moduleOptions = [
  { label: '公司', value: 'company' },
  { label: '员工', value: 'employee' },
  { label: '设备', value: 'device' },
  { label: '规则', value: 'rule' },
  { label: '账号', value: 'admin' },
  { label: '套餐', value: 'plan' },
  { label: '门店', value: 'store' },
];

const actionOptions = [
  { label: '新增', value: 'create' },
  { label: '修改', value: 'update' },
  { label: '删除', value: 'delete' },
  { label: '启用', value: 'enable' },
  { label: '停用', value: 'disable' },
  { label: '改密', value: 'change_password' },
];

async function doSearch() {
  page.value = 1;
  await load();
}

async function doReset() {
  dateRange.value = [];
  Object.assign(filters, { companyId: '', module: '', action: '' });
  page.value = 1;
  await load();
}

// 详情抽屉
const detail = reactive({ visible: false, row: null });
function openDetail(row) {
  detail.row = row;
  detail.visible = true;
}

onMounted(() => {
  load();
  companyApi
    .list({ page: 1, pageSize: 100 })
    .then((r) => (companies.value = r?.list || []))
    .catch(() => {});
});
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">操作日志</h2>
        <div class="page-desc">只追加不修改，用于追溯"谁在什么时候改了什么" · 共 {{ total }} 条</div>
      </div>
    </div>

    <div class="filter-bar">
      <el-select v-model="filters.companyId" placeholder="全部来源" clearable style="width: 190px">
        <el-option label="平台级操作" value="__PLATFORM__" />
        <el-option v-for="c in companies" :key="c.id" :label="c.name" :value="String(c.id)" />
      </el-select>
      <el-select v-model="filters.module" placeholder="全部模块" clearable style="width: 140px">
        <el-option v-for="m in moduleOptions" :key="m.value" :label="m.label" :value="m.value" />
      </el-select>
      <el-select v-model="filters.action" placeholder="全部动作" clearable style="width: 140px">
        <el-option v-for="a in actionOptions" :key="a.value" :label="a.label" :value="a.value" />
      </el-select>
      <el-date-picker
        v-model="dateRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        style="width: 270px"
      />
      <el-button type="primary" @click="doSearch">查询</el-button>
      <el-button @click="doReset">重置</el-button>
    </div>

    <div class="table-card">
      <el-table v-loading="loading" :data="list" empty-text="暂无数据">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作人" width="140">
          <template #default="{ row }">
            <div>{{ row.operatorName || '系统' }}</div>
            <div class="muted" style="font-size: 12px">{{ row.operatorRole || '' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="模块" width="100">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.module || '—' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="action" label="动作" width="110" />
        <el-table-column prop="description" label="描述" min-width="240" show-overflow-tooltip />
        <el-table-column label="IP" width="140">
          <template #default="{ row }">
            <span class="mono">{{ row.ip || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="详情" width="80" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">查看</el-button>
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

    <el-drawer v-model="detail.visible" title="日志详情" size="460px">
      <el-descriptions v-if="detail.row" :column="1" border size="small">
        <el-descriptions-item label="日志 ID">{{ detail.row.id }}</el-descriptions-item>
        <el-descriptions-item label="时间">{{ fmtTime(detail.row.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="操作人">
          {{ detail.row.operatorName || '系统' }}
          <span class="muted">（{{ detail.row.operatorRole || '—' }}）</span>
        </el-descriptions-item>
        <el-descriptions-item label="公司">
          {{ detail.row.companyId || '平台级' }}
        </el-descriptions-item>
        <el-descriptions-item label="模块">{{ detail.row.module || '—' }}</el-descriptions-item>
        <el-descriptions-item label="动作">{{ detail.row.action || '—' }}</el-descriptions-item>
        <el-descriptions-item label="描述">{{ detail.row.description || '—' }}</el-descriptions-item>
        <el-descriptions-item label="目标">
          {{ detail.row.targetType || '—' }} / {{ detail.row.targetId || '—' }}
        </el-descriptions-item>
        <el-descriptions-item label="IP">{{ detail.row.ip || '—' }}</el-descriptions-item>
        <el-descriptions-item label="变更内容">
          <pre class="detail-json">{{ JSON.stringify(detail.row.detail, null, 2) }}</pre>
        </el-descriptions-item>
      </el-descriptions>
    </el-drawer>
  </div>
</template>

<style scoped>
.detail-json {
  margin: 0;
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 320px;
  overflow: auto;
}
</style>
