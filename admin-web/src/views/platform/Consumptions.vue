<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { platformConsumptionApi } from '@/api/consumption';
import { companyApi } from '@/api/company';
import { useList, fmtTime, rangeToParams } from '@/utils/hooks';

const companies = ref([]);
companyApi
  .list({ page: 1, pageSize: 100 })
  .then((r) => (companies.value = r?.list || []))
  .catch(() => {});

// 日期区间单独放，提交时再摊平成 startDate / endDate
const dateRange = ref([]);

const { list, total, loading, page, size, filters, load, search, reset, onPageChange, onSizeChange } =
  useList(
    (params) => {
      const { startDate, endDate } = rangeToParams(dateRange.value);
      return platformConsumptionApi.list({ ...params, startDate, endDate });
    },
    { pageSize: 20, immediate: false, defaultFilters: { companyId: '' } },
  );

async function doSearch() {
  page.value = 1;
  await load();
}

async function doReset() {
  dateRange.value = [];
  filters.companyId = '';
  page.value = 1;
  await load();
}

// ── 趋势 ──
const trend = ref([]);
const trendLoading = ref(false);
const trendOpen = ref(false);

async function loadTrend() {
  trendLoading.value = true;
  trendOpen.value = true;
  try {
    const { startDate, endDate } = rangeToParams(dateRange.value);
    trend.value = await platformConsumptionApi.trend({
      companyId: filters.companyId || undefined,
      days: 14,
      startDate,
      endDate,
    });
  } catch {
    trend.value = [];
  } finally {
    trendLoading.value = false;
  }
}

const maxTrend = computed(() => Math.max(1, ...trend.value.map((t) => t.count)));

// ── 导出 ──
const exporting = ref(false);

async function onExport() {
  exporting.value = true;
  try {
    const { startDate, endDate } = rangeToParams(dateRange.value);
    await platformConsumptionApi.export({ companyId: filters.companyId || undefined, startDate, endDate });
    ElMessage.success('导出已开始下载');
  } catch {
    ElMessage.error('导出失败');
  } finally {
    exporting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">核销记录</h2>
        <div class="page-desc">全平台核销流水，共 {{ total }} 条</div>
      </div>
      <div>
        <el-button @click="loadTrend">查看趋势</el-button>
        <el-button type="primary" :loading="exporting" @click="onExport">导出 CSV</el-button>
      </div>
    </div>

    <div class="filter-bar">
      <el-select v-model="filters.companyId" placeholder="全部公司" clearable style="width: 200px">
        <el-option v-for="c in companies" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-date-picker
        v-model="dateRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        style="width: 280px"
      />
      <el-button type="primary" @click="doSearch">查询</el-button>
      <el-button @click="doReset">重置</el-button>
    </div>

    <div v-if="trendOpen" class="trend-wrap" style="margin-bottom: 16px">
      <div class="trend-head">
        <div class="trend-title">近 14 天核销趋势（按当前筛选）</div>
        <el-button link @click="trendOpen = false">收起</el-button>
      </div>
      <div v-loading="trendLoading">
        <div v-if="!trend.length" class="trend-empty">暂无数据</div>
        <div v-for="t in trend" :key="t.date" class="trend-row">
          <div class="trend-date">{{ t.date.slice(5) }}</div>
          <div class="trend-bar-track">
            <div class="trend-bar" :style="{ width: `${(t.count / maxTrend) * 100}%` }"></div>
          </div>
          <div class="trend-count">{{ t.count }}</div>
        </div>
      </div>
    </div>

    <div class="table-card">
      <el-table v-loading="loading" :data="list" empty-text="暂无数据">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="核销时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.verifyTime) }}</template>
        </el-table-column>
        <el-table-column label="公司" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.companyName || '—' }}</template>
        </el-table-column>
        <el-table-column label="员工" width="140">
          <template #default="{ row }">
            <div>{{ row.employeeName || '—' }}</div>
            <div v-if="row.employeeNo" class="muted" style="font-size: 12px">
              {{ row.employeeNo }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="门店" min-width="130" show-overflow-tooltip>
          <template #default="{ row }">{{ row.storeName || '—' }}</template>
        </el-table-column>
        <el-table-column label="扣减次数" width="100" align="right">
          <template #default="{ row }">{{ row.deductQuota }}</template>
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
  </div>
</template>

<style scoped>
.trend-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.trend-head .trend-title {
  margin-bottom: 0;
}
</style>
