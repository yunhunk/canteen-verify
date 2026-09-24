<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { storeApi, planApi } from '@/api/system';
import { companyApi } from '@/api/company';

// ── 门店 ──
const stores = ref([]);
const storeLoading = ref(false);
const companies = ref([]);

async function loadStores() {
  storeLoading.value = true;
  try {
    stores.value = (await storeApi.list()) || [];
  } catch {
    stores.value = [];
  } finally {
    storeLoading.value = false;
  }
}

const storeDialog = reactive({ visible: false, mode: 'create', submitting: false });
const storeForm = reactive({ id: '', name: '', companyId: '' });
const storeFormRef = ref(null);
const storeRules = { name: [{ required: true, message: '请输入门店名称', trigger: 'blur' }] };

function openStoreCreate() {
  storeDialog.mode = 'create';
  Object.assign(storeForm, { id: '', name: '', companyId: '' });
  storeDialog.visible = true;
}

function openStoreEdit(row) {
  storeDialog.mode = 'edit';
  Object.assign(storeForm, { id: row.id, name: row.name, companyId: row.companyId || '' });
  storeDialog.visible = true;
}

async function submitStore() {
  const valid = await storeFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  storeDialog.submitting = true;
  try {
    const payload = { name: storeForm.name, companyId: storeForm.companyId || undefined };
    if (storeDialog.mode === 'create') {
      await storeApi.create(payload);
      ElMessage.success('门店已创建');
    } else {
      await storeApi.update(storeForm.id, payload);
      ElMessage.success('已保存');
    }
    storeDialog.visible = false;
    loadStores();
  } catch {
    /* 提示已统一处理 */
  } finally {
    storeDialog.submitting = false;
  }
}

// ── 套餐 ──
const plans = ref([]);
const planLoading = ref(false);

async function loadPlans() {
  planLoading.value = true;
  try {
    plans.value = (await planApi.list()) || [];
  } catch {
    plans.value = [];
  } finally {
    planLoading.value = false;
  }
}

const planDialog = reactive({ visible: false, mode: 'create', submitting: false });
const planForm = reactive({ id: '', name: '', quota: 100, price: 0, validDays: 30, status: 1 });
const planFormRef = ref(null);
const planRules = { name: [{ required: true, message: '请输入套餐名称', trigger: 'blur' }] };

function openPlanCreate() {
  planDialog.mode = 'create';
  Object.assign(planForm, { id: '', name: '', quota: 100, price: 0, validDays: 30, status: 1 });
  planDialog.visible = true;
}

function openPlanEdit(row) {
  planDialog.mode = 'edit';
  Object.assign(planForm, {
    id: row.id,
    name: row.name,
    quota: row.quota,
    price: row.price,
    validDays: row.validDays,
    status: row.status,
  });
  planDialog.visible = true;
}

async function submitPlan() {
  const valid = await planFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  planDialog.submitting = true;
  try {
    const payload = {
      name: planForm.name,
      quota: Number(planForm.quota) || 0,
      price: Number(planForm.price) || 0,
      validDays: Number(planForm.validDays) || 0,
      status: planForm.status,
    };
    if (planDialog.mode === 'create') {
      await planApi.create(payload);
      ElMessage.success('套餐已创建');
    } else {
      await planApi.update(planForm.id, payload);
      ElMessage.success('已保存');
    }
    planDialog.visible = false;
    loadPlans();
  } catch {
    /* 提示已统一处理 */
  } finally {
    planDialog.submitting = false;
  }
}

onMounted(() => {
  loadStores();
  loadPlans();
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
        <h2 class="page-title">门店与套餐</h2>
        <div class="page-desc">门店是核销发生地；套餐决定公司初始配额与有效期</div>
      </div>
    </div>

    <!-- 门店 -->
    <div class="table-card" style="margin-bottom: 16px">
      <div class="sub-head">
        <span class="sub-title">门店</span>
        <el-button type="primary" size="small" @click="openStoreCreate">新增门店</el-button>
      </div>
      <el-table v-loading="storeLoading" :data="stores" empty-text="暂无数据">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="门店名称" min-width="200" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small">
              {{ row.status === 1 ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openStoreEdit(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 套餐 -->
    <div class="table-card">
      <div class="sub-head">
        <span class="sub-title">套餐</span>
        <el-button type="primary" size="small" @click="openPlanCreate">新增套餐</el-button>
      </div>
      <el-table v-loading="planLoading" :data="plans" empty-text="暂无数据">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="套餐名称" min-width="160" />
        <el-table-column prop="quota" label="包含次数" width="110" align="right" />
        <el-table-column label="价格" width="120" align="right">
          <template #default="{ row }">¥{{ Number(row.price).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column prop="validDays" label="有效天数" width="110" align="right" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small">
              {{ row.status === 1 ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openPlanEdit(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 门店弹窗 -->
    <el-dialog
      v-model="storeDialog.visible"
      :title="storeDialog.mode === 'create' ? '新增门店' : '编辑门店'"
      width="440px"
    >
      <el-form ref="storeFormRef" :model="storeForm" :rules="storeRules" label-width="80px">
        <el-form-item label="门店名称" prop="name">
          <el-input v-model="storeForm.name" />
        </el-form-item>
        <el-form-item label="所属公司">
          <el-select v-model="storeForm.companyId" placeholder="选填" clearable style="width: 100%">
            <el-option v-for="c in companies" :key="c.id" :label="c.name" :value="String(c.id)" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="storeDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="storeDialog.submitting" @click="submitStore">
          保存
        </el-button>
      </template>
    </el-dialog>

    <!-- 套餐弹窗 -->
    <el-dialog
      v-model="planDialog.visible"
      :title="planDialog.mode === 'create' ? '新增套餐' : '编辑套餐'"
      width="440px"
    >
      <el-form ref="planFormRef" :model="planForm" :rules="planRules" label-width="90px">
        <el-form-item label="套餐名称" prop="name">
          <el-input v-model="planForm.name" />
        </el-form-item>
        <el-form-item label="包含次数">
          <el-input-number v-model="planForm.quota" :min="0" :step="50" style="width: 100%" />
        </el-form-item>
        <el-form-item label="价格">
          <el-input-number v-model="planForm.price" :min="0" :precision="2" style="width: 100%" />
        </el-form-item>
        <el-form-item label="有效天数">
          <el-input-number v-model="planForm.validDays" :min="0" style="width: 100%" />
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="planForm.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="planDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="planDialog.submitting" @click="submitPlan">
          保存
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.sub-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.sub-title {
  font-size: 15px;
  font-weight: 600;
}
</style>
