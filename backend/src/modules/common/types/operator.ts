/**
 * 操作人上下文
 *
 * 字段名与 JwtUser 保持一致（用 uid 而非 id）——
 * 之前的实现里 service 读 `operator.id`、而 controller 传的是 `JwtUser`
 * （字段名是 `uid`），结果 `undefined === adminId` 恒为 false，
 * 自锁保护静默失效：超管能把自己停用，随即整个平台失去管理入口。
 *
 * 这类"字段名不匹配但类型检查通过"的 bug 不会报错，只会静默错，
 * 所以这里把两边收敛到同一个类型定义上。
 */
export interface Operator {
  /** 与 JwtUser.uid 对齐 */
  uid?: string | null;
  name?: string | null;
  role?: string | null;
}

/** 从 JwtUser 构造 Operator，避免各处手工拼字段 */
export function toOperator(user: { uid?: string; name?: string; role?: string } | null | undefined): Operator {
  return {
    uid: user?.uid ?? null,
    name: user?.name ?? null,
    role: user?.role ?? null,
  };
}
