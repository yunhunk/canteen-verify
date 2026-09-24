import { Transform } from 'class-transformer';

/**
 * 把 ID 类入参统一转成字符串。
 *
 * 为什么必须做：`bigint` 在 MySQL 下 TypeORM 返回 `string`，
 * 本地 SQLite 返回 `number`。不收敛就会出现「本地跑通、生产 400」
 * 这种只在部署时才爆炸的方言差异。
 */
export function ToStr() {
  return Transform(({ value }) => {
    if (value === null || value === undefined || value === '') return value;
    return String(value);
  });
}

/** 同上，但允许为空（可选字段） */
export function ToStrOptional() {
  return Transform(({ value }) => {
    if (value === null || value === undefined || value === '') return undefined;
    return String(value);
  });
}

/** 把查询串里的 '1' / 1 / 'true' 收敛成 boolean */
export function ToBool() {
  return Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    return value === '1' || value === 'true' || value === 1;
  });
}

/** 收敛成数字（查询串里全是 string） */
export function ToInt() {
  return Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  });
}

/**
 * 收敛成数字，但**保留 null** —— 这是它与 ToInt 的唯一区别。
 *
 * 需要它的场景：某个字段的 `null` 和「不传」是两种不同语义。
 * 典型是员工额度 quotaTotal：`null` = 不限制，不传 = 非法请求。
 * 用 ToInt 会把 null 变成 undefined，两者就分不开了。
 */
export function ToIntOrNull() {
  return Transform(({ value }) => {
    if (value === null) return null;
    if (value === undefined || value === '') return undefined;
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  });
}
