<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { feedbackApi, FEEDBACK_TYPES } from '@/api/feedback';
import { companyApi } from '@/api/company';
import { useList, fmtTime } from '@/utils/hooks';

const companies = ref([]);
const pending = ref(0);

const { list, total, loading, page, size, filters, load, onPageChange, onSizeChange } = useList(
  (params) => feedbackApi.list(params),
  { pageSize: 20, defaultFilters: { companyId: '', type: '', status: '', keyword: '' } },
);

/** 类型 → el-tag 的 type 映射 */
const typeTag = (v) => FEEDBACK_TYPES.find((t) => t.value === v)?.tag || 'info';

async function doSearch() {
  page.value = 1;
  await load();
  await refreshPending();
}

async function doReset() {
  Object.assign(filters, { companyId: '', type: '', status: '', keyword: '' });
  page.value = 1;
  await load();
}

/** 快捷筛选：只看待处理 */
async function onlyPending() {
  filters.status = 0;
  page.value = 1;
  await load();
}

async function refreshPending() {
  try {
    const r = await feedbackApi.pendingCount();
    pending.value = r?.pending ?? 0;
  } catch {
    /* 角标失败不影响主流程 */
  }
}

// ── 回复弹窗 ──
const dialog = reactive({ visible: false, row: null, reply: '', submitting: false });

function openReply(row) {
  dialog.row = row;
  dialog.reply = row.reply || '';
  dialog.visible = true;
}

async function submitReply() {
  const text = (dialog.reply || '').trim();
  if (!text) {
    ElMessage.warning('请填写回复内容');
    return;
  }
  dialog.submitting = true;
  try {
    await feedbackApi.reply(dialog.row.id, text);
    ElMessage.success('已回复');
    dialog.visible = false;
    await load();
    await refreshPending();
  } catch {
    /* request.js 已提示 */
  } finally {
    dialog.submitting = false;
  }
}

/** 把「已处理」退回「待处理」 */
async function reopen(row) {
  await feedbackApi.setStatus(row.id, 0);
  ElMessage.success('已退回待处理');
  await load();
  await refreshPending();
}

/** 详情抽屉 */
const detail = reactive({ visible: false, row: null });
function openDetail(row) {
  detail.row = row;
  detail.visible = true;
}

onMounted(() => {
  load();
  refreshPending();
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
        <h2 class="page-title">意见反馈</h2>
        <div class="page-desc">
          来自小程序员工的反馈 · 共 {{ total }} 条
          <el-tag v-if="pending > 0" type="warning" size="small" effect="light" style="margin-left: 8px">
            {{ pending }} 条待处理
          </el-tag>
        </div>
      </div>
      <div>
        <el-button v-if="pending > 0" type="warning" plain @click="onlyPending">
          只看待处理
        </el-button>
      </div>
    </div>

    <div class="filter-bar">
      <el-input
        v-model="filters.keyword"
        placeholder="搜索标题 / 内容 / 员工姓名"
        clearable
        style="width: 220px"
        @keyup.enter="doSearch"
      />
      <el-select v-model="filters.companyId" placeholder="全部公司" clearable style="width: 190px">
        <el-option v-for="c in companies" :key="c.id" :label="c.name" :value="String(c.id)" />
      </el-select>
      <el-select v-model="filters.type" placeholder="全部类型" clearable style="width: 140px">
        <el-option v-for="t in FEEDBACK_TYPES" :key="t.value" :label="t.label" :value="t.value" />
      </el-select>
      <el-select v-model="filters.status" placeholder="全部状态" clearable style="width: 130px">
        <el-option label="待处理" :value="0" />
        <el-option label="已处理" :value="1" />
      </el-select>
      <el-button type="primary" @click="doSearch">查询</el-button>
      <el-button @click="doReset">重置</el-button>
    </div>

    <div class="table-card">
      <el-table v-loading="loading" :data="list" empty-text="暂无数据">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="提交时间" width="150">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="公司 / 员工" width="180">
          <template #default="{ row }">
            <div>{{ row.companyName || '—' }}</div>
            <div class="muted" style="font-size: 12px">{{ row.employeeName || '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="typeTag(row.type)" effect="plain">
              {{ row.typeLabel }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
        <el-table-column prop="content" label="内容" min-width="240" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 1 ? 'success' : 'warning'">
              {{ row.status === 1 ? '已处理' : '待处理' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button link type="primary" @click="openReply(row)">
              {{ row.status === 1 ? '修改回复' : '回复' }}
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

    <!-- 回复弹窗 -->
    <el-dialog v-model="dialog.visible" title="回复反馈" width="560px">
      <div v-if="dialog.row" class="reply-context">
        <div class="reply-meta">
          <el-tag size="small" :type="typeTag(dialog.row.type)" effect="plain">
            {{ dialog.row.typeLabel }}
          </el-tag>
          <span class="muted">
            {{ dialog.row.companyName || '—' }} · {{ dialog.row.employeeName || '—' }} ·
            {{ fmtTime(dialog.row.createdAt) }}
          </span>
        </div>
        <div class="reply-title">{{ dialog.row.title }}</div>
        <div class="reply-content">{{ dialog.row.content }}</div>
        <div v-if="dialog.row.contact" class="reply-contact">
          联系方式：<span class="mono">{{ dialog.row.contact }}</span>
        </div>
      </div>

      <el-input
        v-model="dialog.reply"
        type="textarea"
        :rows="5"
        maxlength="1000"
        show-word-limit
        placeholder="填写给员工的回复内容（员工可在小程序「我的反馈」里看到）"
      />

      <template #footer>
        <el-button @click="dialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="dialog.submitting" @click="submitReply">
          提交回复
        </el-button>
      </template>
    </el-dialog>

    <!-- 详情抽屉 -->
    <el-drawer v-model="detail.visible" title="反馈详情" size="520px">
      <el-descriptions v-if="detail.row" :column="1" border size="small">
        <el-descriptions-item label="反馈 ID">{{ detail.row.id }}</el-descriptions-item>
        <el-descriptions-item label="提交时间">
          {{ fmtTime(detail.row.createdAt) }}
        </el-descriptions-item>
        <el-descriptions-item label="公司">{{ detail.row.companyName || '—' }}</el-descriptions-item>
        <el-descriptions-item label="员工">
          {{ detail.row.employeeName || '—' }}（ID: {{ detail.row.employeeId }}）
        </el-descriptions-item>
        <el-descriptions-item label="类型">{{ detail.row.typeLabel }}</el-descriptions-item>
        <el-descriptions-item label="联系方式">
          <span class="mono">{{ detail.row.contact || '未填写' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag size="small" :type="detail.row.status === 1 ? 'success' : 'warning'">
            {{ detail.row.status === 1 ? '已处理' : '待处理' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="标题">{{ detail.row.title }}</el-descriptions-item>
        <el-descriptions-item label="内容">
          <div class="detail-text">{{ detail.row.content }}</div>
        </el-descriptions-item>
        <el-descriptions-item v-if="detail.row.reply" label="平台回复">
          <div class="detail-text reply-text">{{ detail.row.reply }}</div>
          <div class="muted" style="font-size: 12px; margin-top: 6px">
            {{ detail.row.replyAdminName || '—' }} · {{ fmtTime(detail.row.repliedAt) }}
          </div>
        </el-descriptions-item>
      </el-descriptions>

      <div v-if="detail.row" style="margin-top: 16px; display: flex; gap: 8px">
        <el-button type="primary" @click="openReply(detail.row); detail.visible = false">
          回复
        </el-button>
        <el-button v-if="detail.row.status === 1" @click="reopen(detail.row); detail.visible = false">
          退回待处理
        </el-button>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.reply-context {
  background: #f7f9fb;
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 16px;
}

.reply-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 12px;
}

.reply-title {
  font-size: 15px;
  font-weight: 600;
  color: #111827;
  margin-bottom: 6px;
}

.reply-content {
  font-size: 13px;
  color: #4a5568;
  line-height: 1.7;
  white-space: pre-wrap;
}

.reply-contact {
  margin-top: 10px;
  font-size: 12px;
  color: #718096;
}

.detail-text {
  white-space: pre-wrap;
  line-height: 1.7;
}

.reply-text {
  color: #22543d;
}
</style>
