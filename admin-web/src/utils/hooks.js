import { ref, reactive } from 'vue';
import { ElMessage } from 'element-plus';

/**
 * 列表页通用逻辑：加载态 / 分页 / 查询 / 错误处理。
 *
 * 后台 9 个页面里 7 个是"筛选 + 表格 + 分页"的同构结构，
 * 抽出来避免每个页面重复写 try/catch/finally 和分页兜底。
 *
 * @param {(params) => Promise<{list:any[], total:number}>} fetcher
 * @param {object} [options]
 */
export function useList(fetcher, options = {}) {
  const { pageSize = 20, immediate = true, defaultFilters = {} } = options;

  const list = ref([]);
  const total = ref(0);
  const loading = ref(false);
  const page = ref(1);
  const size = ref(pageSize);
  const filters = reactive({ ...defaultFilters });

  async function load() {
    loading.value = true;
    try {
      const res = await fetcher({ page: page.value, pageSize: size.value, ...filters });
      list.value = res?.list ?? [];
      total.value = res?.total ?? 0;
    } catch {
      // request.js 已经弹过错误提示，这里只需保证表格不卡在 loading
      list.value = [];
      total.value = 0;
    } finally {
      loading.value = false;
    }
  }

  /** 条件变化时回到第 1 页 */
  function search() {
    page.value = 1;
    return load();
  }

  function reset() {
    Object.keys(filters).forEach((k) => {
      filters[k] = defaultFilters[k] ?? '';
    });
    return search();
  }

  function onPageChange(p) {
    page.value = p;
    return load();
  }

  function onSizeChange(s) {
    size.value = s;
    page.value = 1;
    return load();
  }

  /** 删除/停用后如果当前页空了，自动回退一页 —— 否则用户会看到一张空表 */
  async function reloadAfterMutation() {
    if (list.value.length === 1 && page.value > 1) page.value -= 1;
    await load();
  }

  if (immediate) load();

  return {
    list,
    total,
    loading,
    page,
    size,
    filters,
    load,
    search,
    reset,
    onPageChange,
    onSizeChange,
    reloadAfterMutation,
  };
}

/** 统一的"确认后执行"包装，减少每个页面重复写 ElMessageBox */
export async function confirmThen(message, action, successMsg, title = '请确认') {
  const { ElMessageBox } = await import('element-plus');
  try {
    await ElMessageBox.confirm(message, title, {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return false;
  }
  await action();
  if (successMsg) ElMessage.success(successMsg);
  return true;
}

/** ISO 时间 → YYYY-MM-DD HH:mm */
export function fmtTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

/** ISO 时间 → YYYY-MM-DD */
export function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把 el-date-picker 的 [start, end] 转成后端要的 startDate / endDate */
export function rangeToParams(range) {
  if (!Array.isArray(range) || range.length !== 2) return { startDate: '', endDate: '' };
  return { startDate: range[0] || '', endDate: range[1] || '' };
}
