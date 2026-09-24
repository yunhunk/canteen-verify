<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { consumptionApi } from '@/api/consumption';
import { useList, fmtTime, rangeToParams } from '@/utils/hooks';

const dateRange = ref([]);

const { list, total, loading, page, size, filters, load, onPageChange, onSizeChange } = useList(
  (params) => {
    const { startDate, endDate } = rangeToParams(dateRange.value);
    return consumptionApi.list({ ...params, startDate, endDate });
  },
  { pageSize: 20, immediate: false, defaultFilters: { keyword: '' } },
);

const today = ref({ count: 0 });

async function loadToday() {
  try {
    today.value = await consumptionApi.today();
  } catch {
    today.value = { count: 0 };
  }
}

async function doSearch() {
  page.value = 1;
  await load();
}

async function doReset() {
  dateRange.value = [];
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
    trend.value = await consumptionApi.trend(14);
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
    await consumptionApi.export({ startDate, endDate });
    ElMessage.success('导出已开始下载');
  } catch {
    ElMessage.error('导出失败');
  } finally {
    exporting.value = false;
  }
}

onMounted(() => {
  load();
  loadToday();
});
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">核销记录</h2>
        <div class="page-desc">
          共 {{ total }} 条记录 · 今日已核销
          <strong style="color: var(--tc-primary)">{{ today.count ?? 0 }}</strong> 次
        </div>
      </div>
      <div>
        <el-button @click="loadTrend">查看趋势</el-button>
        <el-button type="primary" :loading="exporting" @click="onExport">导出 CSV</el-button>
      </div>
    </div>

    <div class="filter-bar">
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
        <div class="trend-title">近 14 天核销趋势</div>
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
        <el-table-column label="核销时间" width="170">
          <template #default="{ row }">{{ fmtTime(row.verifyTime) }}</template>
        </el-table-column>
        <el-table-column label="员工" width="150">
          <template #default="{ row }">
            <div>{{ row.employeeName || '—' }}</div>
            <div v-if="row.employeeNo" class="muted" style="font-size: 12px">
              {{ row.employeeNo }}
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="phone" label="手机号" width="140" />
        <el-table-column label="门店" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.storeName || '—' }}</template>
        </el-table-column>
        <el-table-column label="扣减次数" width="110" align="right">
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
