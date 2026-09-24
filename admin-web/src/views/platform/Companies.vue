<script setup>
import { ref, reactive, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { companyApi } from '@/api/company';
import { planApi } from '@/api/system';
import { useList, fmtTime } from '@/utils/hooks';
import {
  MEAL_STANDARD_TIERS,
  mealStandardLabel,
  toMealStandardPayload,
} from '@/utils/constants';

const { list, total, loading, page, size, filters, search, reset, onPageChange, onSizeChange } =
  useList((params) => companyApi.list(params), { pageSize: 20 });

const plans = ref([]);
planApi.list().then((r) => (plans.value = r || [])).catch(() => {});

// ── 新增 / 编辑 ──
const dialog = reactive({ visible: false, mode: 'create', submitting: false });
const formRef = ref(null);
const form = reactive({
  id: '',
  name: '',
  contactName: '',
  contactPhone: '',
  planId: '',
  totalQuota: 0,
  status: 1,
});

const rules = {
  name: [{ required: true, message: '请输入公司名称', trigger: 'blur' }],
  totalQuota: [{ required: true, message: '请输入初始配额', trigger: 'blur' }],
};

function openCreate() {
  dialog.mode = 'create';
  Object.assign(form, {
    id: '',
    name: '',
    contactName: '',
    contactPhone: '',
    planId: '',
    totalQuota: 0,
    status: 1,
  });
  dialog.visible = true;
}

function openEdit(row) {
  dialog.mode = 'edit';
  Object.assign(form, {
    id: row.id,
    name: row.name,
    contactName: row.contactName || '',
    contactPhone: row.contactPhone || '',
    planId: row.planId || '',
    totalQuota: row.totalQuota,
    status: row.status,
  });
  dialog.visible = true;
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  dialog.submitting = true;
  try {
    // 这里刻意**不带餐标**：改餐标走 PUT companies/:id/meal-standard
    // （见下方 submitMeal）。混进来会让同一件事有两条路径、两种审计 action。
    const payload = {
      name: form.name,
      contactName: form.contactName || undefined,
      contactPhone: form.contactPhone || undefined,
      planId: form.planId || undefined,
      totalQuota: Number(form.totalQuota) || 0,
      status: form.status,
    };

    if (dialog.mode === 'create') {
      await companyApi.create(payload);
      ElMessage.success('公司已创建');
    } else {
      await companyApi.update(form.id, payload);
      ElMessage.success('已保存');
    }
    dialog.visible = false;
    search();
  } catch {
    // 错误提示已由请求层统一处理
  } finally {
    dialog.submitting = false;
  }
}

// ── 餐标（平台专用） ──
//
// 单独做一个弹窗，而不是塞进「编辑公司」里：
// 餐标是平台级的对外口径（决定核销机器播报的价格），
// 公司管理员只能在自己的后台看、不能改 —— 把设置动作独立出来，
// 「改公司资料」和「改餐标」就不会被当成同一件事。
const meal = reactive({ visible: false, submitting: false, company: null, value: null });

/**
 * 档位选项。
 *
 * 万一库里存了个档位外的值（早期通过接口直接设的），
 * 临时补一项，否则 el-radio-group 会一项都不选中，
 * 看起来像「餐标丢了」。
 */
const mealOptions = computed(() => {
  const list = MEAL_STANDARD_TIERS.map((t) => ({ value: t, label: `${t} 元` }));
  const cur = toMealStandardPayload(meal.value);
  if (cur !== null && !list.some((o) => o.value === cur)) {
    list.unshift({ value: cur, label: `${cur} 元（自定义）` });
  }
  return list;
});

/** 核销机器实际会念出来的那句话 —— 所见即所得，避免设错口径 */
const mealPreview = computed(() => {
  const n = toMealStandardPayload(meal.value);
  return n === null ? '核销成功' : `核销成功，餐标${n}元`;
});

function openMeal(row) {
  meal.company = row;
  meal.value = row.mealStandard ?? null;
  meal.visible = true;
}

async function submitMeal() {
  const next = toMealStandardPayload(meal.value);
  meal.submitting = true;
  try {
    await companyApi.setMealStandard(meal.company.id, next);
    ElMessage.success(next === null ? '已清除餐标' : `餐标已设为 ${next} 元`);
    meal.visible = false;
    search();
  } catch {
    // 错误提示已由请求层统一处理
  } finally {
    meal.submitting = false;
  }
}

function quotaTag(row) {
  if (row.remainQuota <= 0) return 'danger';
  const ratio = row.remainQuota / (row.totalQuota || 1);
  if (ratio < 0.2) return 'warning';
  return 'success';
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">公司管理</h2>
        <div class="page-desc">共 {{ total }} 家公司</div>
      </div>
      <el-button type="primary" @click="openCreate">新增公司</el-button>
    </div>

    <div class="filter-bar">
      <el-input
        v-model="filters.keyword"
        placeholder="搜索公司名称"
        clearable
        style="width: 240px"
        @keyup.enter="search"
        @clear="search"
      />
      <el-button type="primary" @click="search">查询</el-button>
      <el-button @click="reset">重置</el-button>
    </div>

    <div class="table-card">
      <el-table v-loading="loading" :data="list" empty-text="暂无数据">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="公司名称" min-width="160" show-overflow-tooltip />
        <el-table-column label="联系人" min-width="140">
          <template #default="{ row }">
            <div>{{ row.contactName || '—' }}</div>
            <div class="muted" style="font-size: 12px">{{ row.contactPhone || '' }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="planName" label="套餐" width="120">
          <template #default="{ row }">{{ row.planName || '—' }}</template>
        </el-table-column>
        <el-table-column label="剩余 / 总额" width="130" align="right">
          <template #default="{ row }">
            <el-tag :type="quotaTag(row)" size="small" effect="light">
              {{ row.remainQuota }} / {{ row.totalQuota }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="employeeCount" label="员工数" width="90" align="right" />
        <el-table-column label="餐标" width="90" align="right">
          <template #default="{ row }">
            <el-tag v-if="row.mealStandard !== null && row.mealStandard !== undefined" size="small" effect="plain">
              {{ mealStandardLabel(row.mealStandard) }}
            </el-tag>
            <span v-else class="muted">未设置</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small">
              {{ row.status === 1 ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openMeal(row)">餐标</el-button>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
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
      :title="dialog.mode === 'create' ? '新增公司' : '编辑公司'"
      width="520px"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="公司名称" prop="name">
          <el-input v-model="form.name" placeholder="请输入公司名称" />
        </el-form-item>
        <el-form-item label="联系人">
          <el-input v-model="form.contactName" placeholder="选填" />
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="form.contactPhone" placeholder="选填" />
        </el-form-item>
        <el-form-item label="套餐">
          <el-select v-model="form.planId" placeholder="不选则自定义配额" clearable style="width: 100%">
            <el-option
              v-for="p in plans"
              :key="p.id"
              :label="`${p.name}（${p.quota} 次 / ¥${p.price}）`"
              :value="p.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="初始配额" prop="totalQuota">
          <el-input-number v-model="form.totalQuota" :min="0" :step="100" style="width: 100%" />
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

    <!-- 设置餐标（平台专用） -->
    <el-dialog v-model="meal.visible" title="设置餐标" width="500px">
      <div v-if="meal.company" class="meal-company">
        {{ meal.company.name }}
        <span class="muted"> · 当前：{{ mealStandardLabel(meal.company.mealStandard) }}</span>
      </div>

      <el-radio-group v-model="meal.value" class="meal-radio">
        <el-radio-button v-for="o in mealOptions" :key="String(o.value)" :value="o.value">
          {{ o.label }}
        </el-radio-button>
        <el-radio-button :value="null">不设置</el-radio-button>
      </el-radio-group>

      <div class="meal-preview">
        <span class="muted">核销机器将播报</span>
        <span class="meal-preview-voice">「{{ mealPreview }}」</span>
      </div>

      <div class="meal-hint">
        餐标由平台设置，公司管理员只能查看、不能修改。改动会立即对该公司生效。
      </div>

      <template #footer>
        <el-button @click="meal.visible = false">取消</el-button>
        <el-button type="primary" :loading="meal.submitting" @click="submitMeal">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.meal-company {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 16px;
}

.meal-radio {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 0;
}

.meal-preview {
  margin-top: 18px;
  padding: 12px 14px;
  background: #f7fafc;
  border: 1px dashed var(--tc-border);
  border-radius: 8px;
  font-size: 13px;
}

.meal-preview-voice {
  margin-left: 8px;
  color: var(--tc-primary);
  font-weight: 600;
}

.meal-hint {
  margin-top: 12px;
  font-size: 12px;
  color: var(--tc-text-sub);
  line-height: 1.6;
}
</style>
