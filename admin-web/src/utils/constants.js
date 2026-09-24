/**
 * 前端共享常量。
 *
 * ⚠️ 这里的 MEAL_STANDARD_TIERS 是**后端常量的镜像**
 * （后端 `src/modules/common/utils/meal-standard.ts`）。
 *
 * 为什么允许这份重复：公司端设置页的档位直接读后端
 * `GET /company/settings` 返回的 `tiers`（永远同步）；但平台端
 * 「公司管理」的编辑弹窗没有公司身份，读不到那个接口，
 * 为 4 个数字再开一个接口不值得，所以在平台端用这份镜像兜底。
 *
 * 后果：后端加了新档位，平台端要跟着改这里。已知且有意识接受的取舍。
 */
export const MEAL_STANDARD_TIERS = [12, 15, 18, 20];

/** 餐标上限（元），与后端一致 */
export const MEAL_STANDARD_MAX = 1000;

/** 餐标展示文案；未设置时给「未设置」而不是空串，避免表格出现空白单元格 */
export function mealStandardLabel(v) {
  if (v === null || v === undefined || v === '') return '未设置';
  const n = Number(v);
  return Number.isNaN(n) ? '未设置' : `${n} 元`;
}

/**
 * 把表单里的餐标值转成提交给后端的形态。
 *
 * 后端用 `null` 表达「清除餐标」，用「不传」表达「本次不改」——
 * 两者语义不同，所以这里必须把 el-select 清空后的产物
 * （可能是 null / '' / undefined，取决于组件版本）统一收敛成 null，
 * 绝不能让它变成 `NaN`（会被 IsNumber 拦成 400）或 `''`（会被当成 0）。
 */
export function toMealStandardPayload(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}
