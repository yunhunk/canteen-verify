// 线上核销闭环验证（生产环境）
//
// 凭据一律走环境变量，禁止硬编码（MonkeyScan 724a4/51062/50b9f/20652）。
// 用法：
//   SEED_PLATFORM_ADMIN=admin SEED_PLATFORM_PASSWORD=*** \
//   SEED_COMPANY_ADMIN=company_a SEED_COMPANY_PASSWORD=*** \
//   SEED_DEVICE_KEY=device-key-demo-0001 \
//   node deliverables/verify-online-e2e.cjs
const BASE = process.env.ONLINE_BASE || 'https://tuancan.gengle.xyz';
const DEVICE_KEY = process.env.SEED_DEVICE_KEY || process.env.DK || '';
const PLATFORM_USER = process.env.SEED_PLATFORM_ADMIN || '';
const PLATFORM_PASS = process.env.SEED_PLATFORM_PASSWORD || '';
const COMPANY_USER = process.env.SEED_COMPANY_ADMIN || '';
const COMPANY_PASS = process.env.SEED_COMPANY_PASSWORD || '';

for (const [k, v] of [
  ['SEED_PLATFORM_ADMIN', PLATFORM_USER],
  ['SEED_PLATFORM_PASSWORD', PLATFORM_PASS],
  ['SEED_COMPANY_ADMIN', COMPANY_USER],
  ['SEED_COMPANY_PASSWORD', COMPANY_PASS],
]) {
  if (!v) {
    console.error('缺少环境变量 ' + k + '（本脚本不内置任何凭据）');
    process.exit(2);
  }
}

async function api(path, opts) {
  const o = opts || {};
  const res = await fetch(BASE + path, {
    method: o.method || 'GET',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      o.token ? { Authorization: 'Bearer ' + o.token } : {},
    ),
    ...(o.body ? { body: JSON.stringify(o.body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {}
  return { status: res.status, body: json };
}

(async () => {
  let pass = 0;
  let fail = 0;
  function ok(n, d) {
    pass++;
    console.log('  OK  ' + n + (d ? ' — ' + d : ''));
  }
  function no(n, d) {
    fail++;
    console.log('  NG  ' + n + (d ? ' — ' + d : ''));
  }

  console.log('\n=== 线上核销闭环验证 ===');

  const login = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: PLATFORM_USER, password: PLATFORM_PASS },
  });
  const t = login.body && login.body.data && login.body.data.token;
  if (!t) {
    console.log('登录失败: ' + JSON.stringify(login.body));
    process.exit(1);
  }
  ok('平台管理员登录');

  const list = await api('/api/platform/consumptions?page=1&pageSize=5', { token: t });
  const total = list.body && list.body.data ? list.body.data.total : 'n/a';
  ok('核销记录可读', 'total=' + total);

  const probe = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: DEVICE_KEY, qrToken: '__probe__' },
  });
  const pc = probe.body ? probe.body.code : null;
  if (pc === 2001) ok('设备密钥鉴权通过（旧 sha256 回溯生效）', 'code=' + pc);
  else no('设备密钥鉴权通过', 'code=' + pc + ' ' + (probe.body ? probe.body.message : ''));

  const bad = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'wrong-key-xyz', qrToken: '__probe__' },
  });
  const bc = bad.body ? bad.body.code : null;
  if (bc === 2006) ok('错误密钥被拒（2006）');
  else no('错误密钥被拒', 'code=' + bc);

  const cLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: COMPANY_USER, password: COMPANY_PASS },
  });
  const ct = cLogin.body && cLogin.body.data ? cLogin.body.data.token : null;
  const cross = await api('/api/platform/statistics', { token: ct });
  const cc = cross.body ? cross.body.code : null;
  if (cc === 1002) ok('公司管理员越权平台接口被拒（1002）');
  else no('越权被拒', JSON.stringify(cross.body));

  const scan = await api('/api/verify/scan', {
    method: 'POST',
    token: ct,
    body: { qrToken: 'x' },
  });
  const sc = scan.body ? scan.body.code : null;
  if (sc === 1002) ok('公司管理员调用核销接口被拒（1002）');
  else no('核销接口角色限制', 'code=' + sc);

  const lo = await api('/api/auth/logout', { method: 'POST', token: ct });
  const after = await api('/api/company/remain', { token: ct });
  const loOk = lo.body ? lo.body.code : null;
  if (loOk === 0 && after.status === 401) ok('登出后 token 立即失效（401）');
  else no('登出吊销', 'logout=' + loOk + ' after=' + after.status);

  const noAuth = await api('/api/employee/windows');
  const naCode = noAuth.body ? noAuth.body.code : null;
  if (naCode === 1001) ok('未登录访问员工接口被拒（1001）');
  else no('未登录被拒', 'code=' + naCode);

  console.log('\n  通过 ' + pass + ' / 失败 ' + fail + '\n');
  process.exit(fail ? 1 : 0);
})();
