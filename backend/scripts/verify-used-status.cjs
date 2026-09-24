/**
 * 端到端验证「核销完成后二维码占位显示已完成（套餐档）」。
 *
 * 链路：员工签发动态码 → 状态 active → 扫码端核销 →
 *       状态接口返回 consumed + 时段名（套餐档）→ 旧码无法重放。
 *
 * Part A：主链路（签发→核销→consumed→重放拒绝→再来一码→active）。
 *         若员工公司配了时段规则，先自动扩宽「午餐」覆盖当前时刻再发码，跑完还原。
 * Part B：套餐档名断言 —— 用公司 1 员工（13900000001，配早/午/晚规则）
 *         核销后必须返回 windowName='午餐'。规则不存在时自动跳过。
 *
 * 前置：员工账号未绑定微信（本地先跑 reset-local-db.js）。
 * 用法：node scripts/verify-used-status.cjs [BASE_URL] [PHONE]
 *   默认 http://127.0.0.1:3311 + 13900000003（本地 B 公司，无规则）；
 *   线上示例：node scripts/verify-used-status.cjs http://66.154.119.26 13900000002
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:3311').replace(/\/$/, '');
const PHONE = process.argv[3] || '13900000003';

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  console.log(`\n═══ 已核销状态感知验证 @ ${BASE}（员工 ${PHONE}）═══`);

  // 0. 公司端登录：若该公司配了「午餐」时段，先扩宽覆盖当前时刻，避免任意时间点被 2005 拦
  const cLoginEarly = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'company_a', password: 'company123456' },
  });
  const cToken = cLoginEarly.body?.data?.token;

  let lunchId = null;
  let lunchOrigStatus = null;
  let lunchOrigLimit = null;
  if (cToken) {
    const rules = await api('/api/company/rules', { token: cToken });
    const list = rules.body?.data?.list || rules.body?.data || [];
    const lunch = Array.isArray(list) ? list.find((r) => r.name === '午餐') : null;
    if (lunch) {
      lunchId = lunch.id;
      lunchOrigStatus = lunch.status;
      lunchOrigLimit = lunch.perEmployeeLimit ?? lunch.per_employee_limit;
      // 扩宽 + 启用 + 限次归零（0=不限）：线上规则可能停用且限次 1，
      // 不改的话员工互相挤占时段名额、停用规则则没有套餐档名
      const widened = await api(`/api/company/rules/${lunchId}`, {
        method: 'PUT',
        token: cToken,
        body: { name: '午餐', startTime: '00:00', endTime: '23:59', status: 1, perEmployeeLimit: 0 },
      });
      check('临时扩宽并启用午餐时段（覆盖当前时刻）', widened.body?.code === 0,
        JSON.stringify(widened.body).slice(0, 140));
    }
  }

  // 1. 员工登录 + 签发
  const login = await api('/api/auth/employee/login', {
    method: 'POST',
    body: { code: `used-status-${Date.now()}`, phone: PHONE },
  });
  const empToken = login.body?.data?.token;
  check(`员工登录（${PHONE}）`, !!empToken, JSON.stringify(login.body).slice(0, 120));
  if (!empToken) { console.log(`通过 ${pass} / 失败 ${fail}`); process.exit(1); return; }

  const issued = await api('/api/employee/qrcode', { method: 'POST', token: empToken, body: {} });
  const qrToken = issued.body?.data?.qrToken;
  check('签发动态核销码', !!qrToken, JSON.stringify(issued.body).slice(0, 120));

  // 2. 签发后马上查状态：应为 active 且剩余秒数在 (0, TTL] 内
  const stActive = await api('/api/employee/qrcode/status', { token: empToken });
  check('签发后状态 = active',
    stActive.body?.data?.state === 'active' &&
      stActive.body?.data?.remainSeconds > 0 &&
      stActive.body?.data?.remainSeconds <= 330,
    JSON.stringify(stActive.body).slice(0, 140));

  // 3. 核销（扫码端带 TCV1: 前缀提交，模拟现场）
  const verify = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0001', qrToken: `TCV1:${qrToken}` },
  });
  check('扫码端核销成功', verify.body?.code === 0 && verify.body?.data?.success === true,
    JSON.stringify(verify.body).slice(0, 160));

  // 4. 状态接口立即返回 consumed + 核销时间（windowName 档名断言见 Part B）
  const stUsed = await api('/api/employee/qrcode/status', { token: empToken });
  check('核销后状态 = consumed',
    stUsed.body?.data?.state === 'consumed',
    JSON.stringify(stUsed.body).slice(0, 160));
  check('consumed 带核销时间',
    !!stUsed.body?.data?.verifyTime,
    `verifyTime=${JSON.stringify(stUsed.body?.data?.verifyTime)}`);

  // 5. 已核销的码不能重放（status=2 必须被拒绝）
  const replay = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0001', qrToken: `TCV1:${qrToken}` },
  });
  check('已核销的码不能二次核销', replay.body?.code !== 0,
    JSON.stringify(replay.body).slice(0, 140));

  // 6. 刷新出一张新码后状态回到 active（「再来一码」路径）
  const issued2 = await api('/api/employee/qrcode', { method: 'POST', token: empToken, body: {} });
  check('签发新码成功（再来一码）', !!issued2.body?.data?.qrToken,
    JSON.stringify(issued2.body).slice(0, 120));
  const stActive2 = await api('/api/employee/qrcode/status', { token: empToken });
  check('新码状态回到 active', stActive2.body?.data?.state === 'active',
    JSON.stringify(stActive2.body).slice(0, 140));

  // ─────────────────────────────────────────────────────────────
  // Part B：套餐档名断言 —— 用配了早/午/晚规则的公司 1 员工张三验证
  //（时间已在前面扩宽覆盖当前时刻；「午餐」规则不存在时整段跳过）
  // ─────────────────────────────────────────────────────────────
  if (lunchId && cToken) {
    const loginA = await api('/api/auth/employee/login', {
      method: 'POST',
      body: { code: `used-status-a-${Date.now()}`, phone: '13900000001' },
    });
    const tokenA = loginA.body?.data?.token;
    check('员工登录（13900000001 张三）', !!tokenA, JSON.stringify(loginA.body).slice(0, 120));

    if (tokenA) {
      const issueA = await api('/api/employee/qrcode', { method: 'POST', token: tokenA, body: {} });
      const qrA = issueA.body?.data?.qrToken;
      check('张三签发动态码', !!qrA, JSON.stringify(issueA.body).slice(0, 120));

      const verifyA = await api('/api/device/verify', {
        method: 'POST',
        body: { deviceKey: 'device-key-demo-0001', qrToken: `TCV1:${qrA}` },
      });
      check('张三核销成功（时段内）', verifyA.body?.code === 0,
        JSON.stringify(verifyA.body).slice(0, 160));

      const stA = await api('/api/employee/qrcode/status', { token: tokenA });
      check('张三状态 = consumed + 套餐档名「午餐」',
        stA.body?.data?.state === 'consumed' && stA.body?.data?.windowName === '午餐',
        JSON.stringify(stA.body).slice(0, 160));
    }

    // 还原种子时段、启停状态与限次（线上原值 status=0 / limit=1，本地 status=1 / limit=1）
    const origLimit = lunchOrigLimit === 0 ? 0 : (lunchOrigLimit || 1);
    const restored = await api(`/api/company/rules/${lunchId}`, {
      method: 'PUT',
      token: cToken,
      body: {
        name: '午餐', startTime: '11:30', endTime: '13:30',
        status: lunchOrigStatus === 1 ? 1 : 0,
        perEmployeeLimit: origLimit,
      },
    });
    check(`午餐时段已还原（11:30-13:30，status=${lunchOrigStatus === 1 ? 1 : 0}，limit=${origLimit}）`,
      restored.body?.code === 0,
      JSON.stringify(restored.body).slice(0, 140));
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  通过 ${pass} / 失败 ${fail}`);
  console.log(`${'═'.repeat(50)}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
