import { BizException } from '../biz-code';

/**
 * 餐标（元）工具。
 *
 * 为什么独立成文件而不是塞在 company.service 里：
 * 公司端设置、平台端编辑、核销播报、员工端展示**四处**都要用它，
 * 放在某个 service 里会让别的模块为了一个纯函数去 import 一个 service
 * （进而牵扯 DI 依赖，迟早绕成循环）。
 */

/**
 * 餐标档位（元）。**单一来源** —— 公司端设置页、平台端公司编辑、
 * 小程序展示都从这里读，避免三处各写一份、改档位时漏改。
 *
 * 新增档位只需往数组里加一个数，前端下拉会自动多一项；
 * 后端校验只做范围检查（0 < 值 <= MEAL_STANDARD_MAX），不锁死在这四个数上 ——
 * 免得将来某家公司谈了个 13 元的餐标还要改代码。
 */
export const MEAL_STANDARD_TIERS = [12, 15, 18, 20] as const;

/** 餐标上限（元）—— 防手滑输入 15000 */
export const MEAL_STANDARD_MAX = 1000;

/**
 * 把库里的 DECIMAL 归一成 number | null。
 *
 * 必须做这一步：MySQL 驱动返回 decimal 是**字符串** `'15.00'`（保精度），
 * SQLite 返回 number `15`。不归一就会出现「本地 15、生产 '15.00'」，
 * 前端 `=== 15` 判断全挂。
 */
export function toMealStandard(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

/**
 * 校验并归一化餐标入参。
 *
 * 允许 `null`（= 清除餐标），其余必须是 0 到 MEAL_STANDARD_MAX 之间的数字。
 * 0 视为「清除」—— 餐标 0 元没有业务含义，与其存个 0 让播报变成
 * 「核销成功，餐标0元」，不如统一按未设置处理。
 */
export function normalizeMealStandard(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n)) {
    throw BizException.badRequest('餐标必须是数字');
  }
  if (n < 0) throw BizException.badRequest('餐标不能为负数');
  if (n > MEAL_STANDARD_MAX) {
    throw BizException.badRequest(`餐标不能超过 ${MEAL_STANDARD_MAX} 元`);
  }
  if (n === 0) return null;
  // 只保留两位小数，与 DECIMAL(10,2) 一致，避免 15.005 存进去变 15.01 后前后不一致
  return Math.round(n * 100) / 100;
}

/** 给人看的餐标文案；未设置时返回「未设置」 */
export function mealStandardText(raw: unknown): string {
  const n = toMealStandard(raw);
  return n === null ? '未设置' : `${n} 元`;
}

/**
 * 核销机器语音播报文本。
 *
 * 机器（扫码枪 / 闸机）自己读这个字段做 TTS，我们只负责给出**该念什么**。
 * 形如 `核销成功，餐标15元`；公司未设餐标时退回 `核销成功`。
 *
 * 金额去尾零：15.00 → 15，15.50 → 15.5 —— 否则 TTS 会念成
 * 「餐标十五点零零元」，很怪。
 */
export function buildVerifyVoiceText(raw: unknown): string {
  const n = toMealStandard(raw);
  if (n === null) return '核销成功';
  return `核销成功，餐标${formatYuan(n)}元`;
}

/** 去掉无意义的小数尾零：15 → '15'，15.5 → '15.5'，15.25 → '15.25' */
export function formatYuan(n: number): string {
  return String(Number(n.toFixed(2)));
}
