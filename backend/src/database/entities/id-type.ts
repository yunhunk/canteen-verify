/**
 * 主键类型适配
 *
 * 生产 MySQL 用 `bigint`；本地零依赖模式（SQLite WASM）必须用 `integer` ——
 * SQLite 的 AUTOINCREMENT 只允许出现在 `INTEGER PRIMARY KEY` 上，
 * 写成 `bigint` 会直接抛 "AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY"。
 *
 * 这是方言差异里最容易踩的一个：实体写死了 bigint，本地模式就连表都建不出来。
 */
export const PRIMARY_ID_TYPE: 'bigint' | 'integer' =
  process.env.LOCAL_MODE === '1' ? 'integer' : 'bigint';
