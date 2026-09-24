/**
 * 端到端验证「TCV1: 前缀」修复。
 *
 * 复现现场：员工小程序的二维码内容 = `TCV1:<token>`（qr-encoder.buildQrPayload），
 * 扫码端原样提交 → 核销接口必须能剥前缀命中裸 token。
 *
 * 用法：node scripts/verify-tcv1-fix.cjs [BASE_URL]
 *   默认 http://127.0.0.1:3311（本地）；线上传 http://66.154.119.26
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:3311').replace(/\/$/, '');

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
  console.log(`\n═══ TCV1 前缀修复验证 @ ${BASE} ═══`);

  // 1. 员工登录（本地/线上均为 mock openid 通道，code 任意）
  const login = await api('/api/auth/employee/login', {
    method: 'POST',
    body: { code: `tcv1-fix-${Date.now()}`, phone: '13900000003' },
  });
  const empToken = login.body?.data?.token || login.body?.data?.accessToken;
  check('员工登录（13900000003）', !!empToken, JSON.stringify(login.body).slice(0, 120));

  // 2. 签发动态码
  const issued = await api('/api/employee/qrcode', {
    method: 'POST',
    token: empToken,
    body: {},
  });
  const qrToken = issued.body?.data?.qrToken;
  check('签发动态核销码', typeof qrToken === 'string' && qrToken.length > 0,
    JSON.stringify(issued.body).slice(0, 120));

  // 3. 复现现场：把二维码内容（TCV1: 前缀）原样提交 —— 修复后必须成功
  const withPrefix = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0001', qrToken: `TCV1:${qrToken}` },
  });
  check('带 TCV1: 前缀核销成功（现场场景）',
    withPrefix.body?.code === 0 && withPrefix.body?.data?.success === true,
    JSON.stringify(withPrefix.body).slice(0, 160));

  // 4. 该码已一次性消费：再次提交（同内容）应判重复或无效，不能再成功
  const replay = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0001', qrToken: `TCV1:${qrToken}` },
  });
  check('已消费的码不能二次核销', replay.body?.code !== 0,
    JSON.stringify(replay.body).slice(0, 120));

  // 5. 兼容裸 token：新签一码，不带前缀提交也应成功（老扫码枪场景）
  const issued2 = await api('/api/employee/qrcode', { method: 'POST', token: empToken, body: {} });
  const qrToken2 = issued2.body?.data?.qrToken;
  const bare = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0001', qrToken: qrToken2 },
  });
  check('裸 token（无前缀）核销成功（兼容老扫码枪）',
    bare.body?.code === 0 && bare.body?.data?.success === true,
    JSON.stringify(bare.body).slice(0, 160));

  // 6. 首尾空白容错：手动输码常见
  const issued3 = await api('/api/employee/qrcode', { method: 'POST', token: empToken, body: {} });
  const qrToken3 = issued3.body?.data?.qrToken;
  const padded = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0001', qrToken: `  TCV1:${qrToken3}  ` },
  });
  check('带首尾空白仍核销成功（手动输码容错）',
    padded.body?.code === 0 && padded.body?.data?.success === true,
    JSON.stringify(padded.body).slice(0, 160));

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  通过 ${pass} / 失败 ${fail}`);
  console.log(`${'═'.repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
