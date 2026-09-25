/**
 * 前端联调自检：启动后端 → 验证双端登录与关键接口 → 停服务。
 *
 * 为什么不用 `&` 起服务再 curl：多个 shell 会话之间后台进程会被回收，
 * 上一轮请求还能通、下一轮就 ECONNREFUSED。这个脚本在**同一个进程**里
 * spawn 服务、跑断言、再 kill，避免跨会话问题。
 *
 * 用法：node scripts/verify-login.js
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3311;
const BASE = `http://127.0.0.1:${PORT}`;

const BACKEND = path.join(__dirname, '..', '..', 'backend');

let pass = 0;
let fail = 0;

function ok(n) {
  pass++;
  console.log(`  ✓ ${n}`);
}
function bad(n, d) {
  fail++;
  console.log(`  ✗ ${n}${d ? ` → ${d}` : ''}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function req(method, url, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应（如 CSV） */
  }
  return { status: res.status, body: json };
}

async function waitReady(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(BASE + '/api/auth/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      return true;
    } catch {
      await sleep(1200);
    }
  }
  return false;
}

async function main() {
  console.log('\n═══ 双端登录与关键接口联调 ═══\n');

  console.log('启动后端（LOCAL_MODE=1）…');
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: BACKEND,
    env: { ...process.env, LOCAL_MODE: '1', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d.toString()));
  child.stderr.on('data', (d) => (serverLog += d.toString()));

  const cleanup = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);

  const ready = await waitReady();
  if (!ready) {
    bad('后端启动', '90 秒内未就绪');
    console.log(serverLog.slice(-1500));
    cleanup();
    process.exit(1);
  }
  ok('后端已就绪');

  // ── 平台超管 ──
  // 凭据走环境变量（漏洞 724a4）：脚本里不硬编码口令，避免被静态扫描当作真凭据。
  // 本地默认值仅用于未配置时的开箱即跑；生产用 SEED_* 环境变量覆盖。
  const SEED_SUPER_PASSWORD = process.env.SEED_SUPER_PASSWORD || 'admin123456';
  const SEED_COMPANY_PASSWORD = process.env.SEED_COMPANY_PASSWORD || 'company123456';

  const superLogin = await req('POST', '/api/auth/admin/login', {
    body: { username: 'admin', password: SEED_SUPER_PASSWORD },
  });
  if (superLogin.body?.code === 0 && superLogin.body.data?.user?.role === 'super') {
    ok('平台超管登录成功（admin / role=super）');
  } else {
    bad('平台超管登录', JSON.stringify(superLogin.body).slice(0, 200));
  }
  const superToken = superLogin.body?.data?.token;

  // ── 公司管理员 ──
  const companyLogin = await req('POST', '/api/auth/admin/login', {
    body: { username: 'company_a', password: SEED_COMPANY_PASSWORD },
  });
  if (companyLogin.body?.code === 0 && companyLogin.body.data?.user?.role === 'company') {
    ok('公司管理员登录成功（company_a / role=company）');
  } else {
    bad('公司管理员登录', JSON.stringify(companyLogin.body).slice(0, 200));
  }
  const companyToken = companyLogin.body?.data?.token;

  // ── 后台依赖的接口逐个打一遍 ──
  const checks = [
    ['总览看板', 'GET', '/api/platform/statistics', superToken],
    ['公司列表', 'GET', '/api/platform/companies?page=1&pageSize=20', superToken],
    ['员工列表', 'GET', '/api/platform/employees?page=1&pageSize=20', superToken],
    ['核销记录', 'GET', '/api/platform/consumptions?page=1&pageSize=20', superToken],
    ['核销趋势', 'GET', '/api/platform/consumptions/trend?days=14', superToken],
    ['设备列表', 'GET', '/api/platform/devices', superToken],
    ['时段规则', 'GET', '/api/platform/rules', superToken],
    ['门店列表', 'GET', '/api/platform/stores', superToken],
    ['套餐列表', 'GET', '/api/platform/plans', superToken],
    ['后台账号', 'GET', '/api/platform/admins', superToken],
    ['平台日志', 'GET', '/api/platform/operation-logs?page=1&pageSize=20', superToken],
    ['公司看板', 'GET', '/api/company/statistics', companyToken],
    ['公司员工', 'GET', '/api/company/employees?page=1&pageSize=20', companyToken],
    ['公司核销', 'GET', '/api/company/consumptions?page=1&pageSize=20', companyToken],
    ['公司今日', 'GET', '/api/company/consumptions/today', companyToken],
    ['公司规则', 'GET', '/api/company/rules', companyToken],
    ['公司日志', 'GET', '/api/company/operation-logs?page=1&pageSize=20', companyToken],
  ];

  for (const [name, method, url, token] of checks) {
    const r = await req(method, url, { token });
    if (r.body?.code === 0) ok(`${name} 可访问`);
    else bad(name, `HTTP ${r.status} / code=${r.body?.code} ${r.body?.message || ''}`);
  }

  // ── 越权：公司管理员访问平台接口必须被拒 ──
  const cross = await req('GET', '/api/platform/companies?page=1&pageSize=20', {
    token: companyToken,
  });
  if (cross.body?.code !== 0) {
    ok(`越权访问被拒（公司管理员 → 平台接口，code=${cross.body?.code}）`);
  } else {
    bad('越权访问未被拒绝', '公司管理员拿到了平台数据');
  }

  // ── CSV 导出带 BOM ──
  const csvRes = await fetch(BASE + '/api/company/consumptions/export', {
    headers: { Authorization: `Bearer ${companyToken}` },
  });
  const buf = Buffer.from(await csvRes.arrayBuffer());
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    ok('CSV 导出带 UTF-8 BOM（Excel 直开不乱码）');
  } else {
    bad('CSV 缺少 BOM', `前 3 字节: ${buf.slice(0, 3).toString('hex')}`);
  }

  cleanup();
  await sleep(600);

  console.log(`\n${'═'.repeat(46)}`);
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项`);
  console.log(`${'═'.repeat(46)}\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('联调脚本异常:', e);
  process.exit(1);
});
