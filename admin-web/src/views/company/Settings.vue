<script setup>
import { computed, onMounted, ref } from 'vue';
import { companySelfApi } from '@/api/company';
import { MEAL_STANDARD_TIERS, mealStandardLabel } from '@/utils/constants';

/**
 * 公司设置 —— **只读**。
 *
 * 目前只有一项：餐标。它是**公司级**配置（全公司一个标准），
 * 与「员工管理」里的个人核销次数是两个维度，别混淆：
 *   餐标 = 一顿饭值多少钱（只影响展示与机器播报，不参与扣减）
 *   次数 = 这个人还能核销几次（真正影响能不能核销）
 *
 * 为什么这里没有保存按钮：餐标决定核销机器对外播报的价格口径，
 * 由平台统一设置。公司管理员看得到当前值、也能看到可选档位
 * （好跟平台说同一个数），但不能改 —— 后台没有任何写接口可调，
 * 前端再放一个禁用按钮只会让人反复点。
 */

const loading = ref(true);
const errorMsg = ref('');

const companyName = ref('');
/** 当前餐标；null 表示平台尚未设置 */
const mealStandard = ref(null);
const tiers = ref([...MEAL_STANDARD_TIERS]);

/** 可选档位文案，供管理员跟平台沟通时对齐 */
const tiersText = computed(() => `${tiers.value.join(' / ')} 元`);

/** 核销机器实际会念出来的那句话 —— 让管理员一眼确认口径对不对 */
const voicePreview = computed(() => {
  const n = mealStandard.value;
  return n === null || n === undefined ? '核销成功' : `核销成功，餐标${n}元`;
});

async function load() {
  loading.value = true;
  errorMsg.value = '';
  try {
    const res = await companySelfApi.settings();
    companyName.value = res?.companyName || '';
    if (Array.isArray(res?.tiers) && res.tiers.length) tiers.value = res.tiers;
    mealStandard.value = res?.mealStandard ?? null;
  } catch (e) {
    errorMsg.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">公司设置</h2>
        <div class="page-desc">
          {{ companyName ? `${companyName} · ` : '' }}餐标由平台统一设置，员工核销时机器会播报。
        </div>
      </div>
    </div>

    <div v-if="loading" class="table-card">
      <el-skeleton :rows="3" animated />
    </div>

    <el-alert
      v-else-if="errorMsg"
      type="error"
      :closable="false"
      show-icon
      :title="errorMsg"
      description="请检查网络后重试；若持续失败请联系平台管理员。"
    >
      <template #default>
        <el-button size="small" style="margin-top: 8px" @click="load">重试</el-button>
      </template>
    </el-alert>

    <div v-else class="table-card">
      <div class="sett-block">
        <div class="sett-label">餐标</div>
        <div class="sett-desc">
          全公司使用同一个餐标。核销成功后，门店的核销机器会语音播报
          「核销成功，餐标 N 元」。餐标<b>只用于展示与播报</b>，不会改变扣除的次数。
        </div>

        <div class="sett-current">
          当前：<span class="sett-current-value">{{ mealStandardLabel(mealStandard) }}</span>
        </div>

        <div class="sett-preview">
          <span class="sett-preview-label">机器将播报</span>
          <span class="sett-preview-voice">「{{ voicePreview }}」</span>
        </div>

        <el-alert
          class="sett-readonly"
          type="info"
          :closable="false"
          show-icon
          title="餐标由平台管理员统一设置，此处仅可查看"
          :description="`如需调整请联系平台管理员。可选档位：${tiersText}。`"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.sett-block {
  max-width: 720px;
  padding: 8px 4px 16px;
}

.sett-label {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 8px;
}

.sett-desc {
  font-size: 13px;
  color: var(--tc-text-sub);
  line-height: 1.7;
  margin-bottom: 18px;
}

.sett-current {
  font-size: 13px;
  color: var(--tc-text-sub);
  margin-bottom: 14px;
}

.sett-current-value {
  color: var(--tc-primary);
  font-weight: 600;
  font-size: 15px;
}

.sett-preview {
  padding: 12px 14px;
  background: #f7fafc;
  border: 1px dashed var(--tc-border);
  border-radius: 8px;
  font-size: 13px;
}

.sett-preview-label {
  color: var(--tc-text-sub);
  margin-right: 8px;
}

.sett-preview-voice {
  color: var(--tc-primary);
  font-weight: 600;
}

.sett-readonly {
  margin-top: 20px;
}
</style>
