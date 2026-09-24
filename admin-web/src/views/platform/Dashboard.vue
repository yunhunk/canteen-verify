<script setup>
import { ref, onMounted, computed } from 'vue';
import { companyApi } from '@/api/company';
import { platformConsumptionApi } from '@/api/consumption';
import { useList } from '@/utils/hooks';

const stat = ref(null);
const loading = ref(true);
const trendDays = ref(14);

const trend = ref([]);
const trendLoading = ref(false);

/** 剩余次数最少的公司 —— 快用完了需要提前提示续费 */
const lowQuota = computed(() => {
  if (!companies.value?.length) return [];
  return [...companies.value]
    .filter((c) => c.totalQuota > 0)
    .sort((a, b) => a.remainQuota / (a.totalQuota || 1) - b.remainQuota / (b.totalQuota || 1))
    .slice(0, 5);
});

const {
  list: companies,
  loading: companyLoading,
  load: loadCompanies,
} = useList((params) => companyApi.list(params), { pageSize: 100, immediate: false });

async function loadStat() {
  loading.value = true;
  try {
    stat.value = await companyApi.statistics();
  } catch {
    stat.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadTrend() {
  trendLoading.value = true;
  try {
    trend.value = await platformConsumptionApi.trend({ days: trendDays.value });
  } catch {
    trend.value = [];
  } finally {
    trendLoading.value = false;
  }
}

const maxTrend = computed(() => Math.max(1, ...trend.value.map((t) => t.count)));

onMounted(() => {
  loadStat();
  loadTrend();
  loadCompanies();
});
</script>

<template>
  <div v-loading="loading">
    <div class="page-head">
      <div>
        <h2 class="page-title">总览看板</h2>
        <div class="page-desc">全平台公司、员工、核销与配额总览</div>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card">
        <div class="label">入驻公司</div>
        <div class="value primary">{{ stat?.totalCompanies ?? '—' }}</div>
        <div class="foot">启用中 {{ stat?.activeCompanies ?? 0 }} 家</div>
      </div>

      <div class="stat-card">
        <div class="label">员工总数</div>
        <div class="value">{{ stat?.totalEmployees ?? '—' }}</div>
        <div class="foot">在职 {{ stat?.activeEmployees ?? 0 }} 人</div>
      </div>

      <div class="stat-card">
        <div class="label">累计核销</div>
        <div class="value ok">{{ stat?.totalConsumptions ?? '—' }}</div>
        <div class="foot">今日 {{ stat?.todayConsumptions ?? 0 }} 次</div>
      </div>

      <div class="stat-card">
        <div class="label">剩余总次数</div>
        <div class="value warn">{{ stat?.remainQuota ?? '—' }}</div>
        <div class="foot">已用 {{ stat?.usedQuota ?? 0 }} / 共 {{ stat?.totalQuota ?? 0 }}</div>
      </div>
    </div>

    <div class="trend-wrap">
      <div class="trend-head">
        <div class="trend-title">核销趋势</div>
        <el-radio-group v-model="trendDays" size="small" @change="loadTrend">
          <el-radio-button :value="7">近 7 天</el-radio-button>
          <el-radio-button :value="14">近 14 天</el-radio-button>
          <el-radio-button :value="30">近 30 天</el-radio-button>
        </el-radio-group>
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

    <div class="trend-wrap mt-16">
      <div class="trend-title">配额告急（剩余比例最低的 5 家）</div>
      <el-table v-loading="companyLoading" :data="lowQuota" size="small" empty-text="暂无数据">
        <el-table-column prop="name" label="公司" min-width="160" />
        <el-table-column prop="remainQuota" label="剩余" width="90" align="right" />
        <el-table-column prop="totalQuota" label="总额" width="90" align="right" />
        <el-table-column label="剩余比例" width="180">
          <template #default="{ row }">
            <el-progress
              :percentage="Math.round((row.remainQuota / (row.totalQuota || 1)) * 100)"
              :stroke-width="12"
              :status="row.remainQuota === 0 ? 'exception' : undefined"
            />
          </template>
        </el-table-column>
      </el-table>
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
