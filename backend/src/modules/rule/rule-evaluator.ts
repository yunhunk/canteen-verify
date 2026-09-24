import { VerificationRule } from '../../database/entities';

export interface TimeWindow {
  start: string; // HH:mm
  end: string;   // HH:mm
}

export interface WindowMatch {
  /** 命中规则对应的「本时段」真实起止（跨天时已落到相邻日期） */
  windowStart: Date;
  windowEnd: Date;
  rule: VerificationRule;
}

/**
 * 判断 now 是否落在 [start, end) 内。
 * end < start 表示跨天（如 22:00-02:00）。
 *
 * `HH:mm` 定宽零填充，字符串比较即可判定区间，无需解析成时间。
 */
export function isInWindow(hhmm: string, start: string, end: string): boolean {
  if (start === end) return false; // 起止相同视为空区间，避免 24h 误解
  if (start < end) {
    return hhmm >= start && hhmm < end;
  }
  // 跨天：22:00-02:00 → hhmm >= 22:00 或 hhmm < 02:00
  return hhmm >= start || hhmm < end;
}

/** 把 Date 转成本地 HH:mm（服务器时区需为 Asia/Shanghai） */
export function toHhmm(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * 计算命中规则对应的统计区间。
 *
 * 跨天是这里唯一的坑：若规则为 22:00-02:00、当前 01:00，
 * 则「本时段」的起点是**昨天** 22:00，终点是**今天** 02:00。
 * 若按「今天 22:00 到今天 02:00」去算，区间是空的，
 * 于是每个人每天在宵夜时段都能无限次核销 —— 这正是必须专门处理的点。
 */
export function resolveWindow(rule: VerificationRule, now: Date): WindowMatch {
  const [sh, sm] = rule.start_time.split(':').map(Number);
  const [eh, em] = rule.end_time.split(':').map(Number);

  const windowStart = new Date(now);
  windowStart.setHours(sh, sm, 0, 0);

  const windowEnd = new Date(now);
  windowEnd.setHours(eh, em, 0, 0);

  const crossDay = rule.start_time > rule.end_time;
  if (crossDay) {
    if (toHhmm(now) >= rule.start_time) {
      // 处于跨天时段的前半段（22:00-23:59）：终点落到明天
      windowEnd.setDate(windowEnd.getDate() + 1);
    } else {
      // 处于后半段（00:00-02:00）：起点落到昨天
      windowStart.setDate(windowStart.getDate() - 1);
    }
  }

  return { windowStart, windowEnd, rule };
}

export interface RuleEvaluation {
  /** false 表示本次核销被时段规则拒绝 */
  allowed: boolean;
  /** 被拒时的可读原因 */
  reason?: string;
  /** 命中规则 id；null 表示无规则限制 */
  matchedRuleId: string | null;
  /** 命中的时段名，用于回传给设备/员工端展示 */
  windowName?: string;
  windowText?: string;
  /** 该时段内每人可核销次数；0 = 不限 */
  limit?: number;
  /** 该时段内已核销次数 */
  used?: number;
  /** 该时段内剩余可核销次数；不限时为 null */
  remain?: number;
  /** 命中多条规则时的完整列表（取最宽松，但全部回落给前端做提示） */
  matchedRules: VerificationRule[];
  /** 统计区间起止 */
  windowStart?: Date;
  windowEnd?: Date;
}

/**
 * 时段规则判定 —— 核销链路的 c 步。
 *
 * 判定顺序（与设计文档 4.2 严格一致）：
 * ├─ 一条启用规则都没有 → 不限制，放行（老租户升级后行为不变）
 * └─ 有规则
 *    ├─ 无规则覆盖当前时刻 → 拒绝，并提示所有可核销时段
 *    └─ 有规则覆盖
 *       ├─ 命中规则里存在 per_employee_limit = 0 → 不限次，放行
 *       └─ 取命中规则里最大的 limit（最宽松）
 *          └─ used >= limit → 拒绝；否则放行并记 rule_id
 *
 * 为什么要「取最宽松」：时段配置常常重叠（如「全天 0 次不限」+
 * 「午餐 1 次」），若取最严格，正常用餐会被莫名拦掉。
 */
export function evaluateRules(
  allRules: VerificationRule[],
  now: Date,
  usedCount: (ruleId: string, window: WindowMatch) => number,
): RuleEvaluation {
  // 没有任何启用规则 = 不限制
  if (!allRules || allRules.length === 0) {
    return { allowed: true, matchedRuleId: null, matchedRules: [] };
  }

  const hhmm = toHhmm(now);
  const matched = allRules.filter((r) => isInWindow(hhmm, r.start_time, r.end_time));

  if (matched.length === 0) {
    const available = allRules
      .map((r) => `${r.name} ${r.start_time}-${r.end_time}`)
      .join('、');
    return {
      allowed: false,
      reason: `当前不在可核销时段，可核销时间：${available}`,
      matchedRuleId: null,
      matchedRules: [],
    };
  }

  // 命中规则中存在不限次 → 直接放行
  const unlimited = matched.find((r) => r.per_employee_limit === 0);
  const winner = unlimited
    ? unlimited
    : matched.reduce((a, b) => (b.per_employee_limit > a.per_employee_limit ? b : a));

  const window = resolveWindow(winner, now);

  if (winner.per_employee_limit === 0) {
    return {
      allowed: true,
      matchedRuleId: String(winner.id),
      windowName: winner.name,
      windowText: `${winner.name} ${winner.start_time}-${winner.end_time}`,
      limit: 0,
      used: usedCount(String(winner.id), window),
      remain: null,
      matchedRules: matched,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
    };
  }

  const used = usedCount(String(winner.id), window);
  const remain = Math.max(0, winner.per_employee_limit - used);

  if (used >= winner.per_employee_limit) {
    return {
      allowed: false,
      reason: `「${winner.name}」时段每人限核销 ${winner.per_employee_limit} 次，本时段次数已用完`,
      matchedRuleId: String(winner.id),
      windowName: winner.name,
      windowText: `${winner.name} ${winner.start_time}-${winner.end_time}`,
      limit: winner.per_employee_limit,
      used,
      remain: 0,
      matchedRules: matched,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
    };
  }

  return {
    allowed: true,
    matchedRuleId: String(winner.id),
    windowName: winner.name,
    windowText: `${winner.name} ${winner.start_time}-${winner.end_time}`,
    limit: winner.per_employee_limit,
    used,
    remain: remain - 1, // 本次核销后的剩余
    matchedRules: matched,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
  };
}
