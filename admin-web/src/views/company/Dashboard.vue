<script setup>
import { ref, computed, onMounted } from 'vue';
import { companySelfApi } from '@/api/company';
import { consumptionApi } from '@/api/consumption';

const stat = ref(null);
const loading = ref(true);

const trend = ref([]);
const trendLoading = ref(false);
const trendDays = ref(14);

async function loadStat() {
  loading.value = true;
  try {
    stat.value = await companySelfApi.statistics();
  } catch {
    stat.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadTrend() {
  trendLoading.value = true;
  try {
    trend.value = await consumptionApi.trend(trendDays.value);
  } catch {
    trend.value = [];
  } finally {
    trendLoading.value = false;
  }
}

const maxTrend = computed(() => Math.max(1, ...trend.value.map((t) => t.count)));

/** 剩余次数占比：低于 20% 给出告警色 */
const remainRatio = computed(() => {
  if (!stat.value?.totalQuota) return 0;
  return Math.round((stat.value.remainQuota / stat.value.totalQuota) * 100);
});

const remainStatus = computed(() => {
  if (!stat.value) return '';
  if (stat.value.remainQuota <= 0) return 'danger';
  if (remainRatio.value < 20) return 'warn';
  return 'ok';
});

onMounted(() => {
  loadStat();
  loadTrend();
});
</script>

<template>
  <div v-loading="loading">
    <div class="page-head">
      <div>
        <h2 class="page-title">公司看板</h2>
        <div class="page-desc">{{ stat?.companyName || '' }}</div>
      </div>
    </div>

    <el-alert
      v-if="remainStatus === 'danger'"
      type="error"
      :closable="false"
      show-icon
      title="配额已用尽"
      description="当前剩余次数为 0，员工将无法继续核销。请联系平台管理员充值。"
      style="margin-bottom: 16px"
    />
    <el-alert
      v-else-if="remainStatus === 'warn'"
      type="warning"
      :closable="false"
      show-icon
      :title="`配额即将用尽（剩余 ${remainRatio}%）`"
      description="建议提前联系平台管理员补充额度，避免影响员工用餐。"
      style="margin-bottom: 16px"
    />

    <div class="stat-grid">
      <div class="stat-card">
        <div class="label">剩余次数</div>
        <div class="value" :class="remainStatus">{{ stat?.remainQuota ?? '—' }}</div>
        <div class="foot">
          总额 {{ stat?.totalQuota ?? 0 }} · 已用 {{ stat?.usedQuota ?? 0 }}
        </div>
      </div>

      <div class="stat-card">
        <div class="label">今日核销</div>
        <div class="value primary">{{ stat?.todayConsumptions ?? '—' }}</div>
        <div class="foot">累计 {{ stat?.totalConsumptions ?? 0 }} 次</div>
      </div>

      <div class="stat-card">
        <div class="label">员工总数</div>
        <div class="value">{{ stat?.employeeCount ?? '—' }}</div>
        <div class="foot">在职 {{ stat?.activeEmployeeCount ?? 0 }} 人</div>
      </div>

      <div class="stat-card">
        <div class="label">配额使用率</div>
        <div class="value">{{ stat ? `${100 - remainRatio}%` : '—' }}</div>
        <div class="foot">剩余 {{ remainRatio }}%</div>
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
