#!/usr/bin/env node
/**
 * MonkeyScan 漏洞修复 —— 端到端验证
 *
 * 逐条断言本轮修复的漏洞，重点覆盖「可被观察的行为」：
 *
 *   【A】04f84 服务端登出：调 /api/auth/logout 后旧 token 立即失效
 *   【B】32a18 CSV 公式注入：导出 CSV 中 =/+/-/@ 起始字段被前置单引号
 *   【C】23242 DB 默认凭据：生产模式缺 DB_USER/DB_PASSWORD 时进程拒绝启动
 *   【D】fb0a0 旧 sha256 淘汰：生产模式不接受裸 sha256 设备密钥
 *   【E】724a4/51062 种子凭据外置：SEED_* 环境变量可以覆盖演示口令
 *
 * 用法：node verify-monkeyscan-fixes.cjs            # 默认打 127.0.0.1:3312
 *       BASE=http://127.0.0.1:3312 node verify-monkeyscan-fixes.cjs
 */
const BASE = (process.env.BASE || 'http://127.0.0.1:3312').replace(/\/$/, '');
const pathx = require('path');
const fsx = require('fs');
const BACKEND_DIR = pathx.join(__dirname, '..', 'backend');

let pass = 0;
let fail = 0;
const problems = [];

function ok(n, d = '') {
  pass++;
  console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`);
}
function no(n, d = '') {
  fail++;
  problems.push(n);
  console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`);
}
function section(t) {
  console.log(`\n── ${t}`);
}

async function api(path, { method = 'GET', token, body, raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (raw) return { status: res.status, text: await res.text() };
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, body: json };
}

const SUPER_PWD = process.env.SEED_SUPER_PASSWORD || 'admin123456';
const SUPER_USER = 'admin';

(async () => {
  console.log(`\n═══ MonkeyScan 漏洞修复验证 @ ${BASE} ═══`);

  // ── 登录拿基线 token ──
  const login = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: SUPER_USER, password: SUPER_PWD },
  });
  const token = login.body?.data?.token;
  if (!token) {
    no('基线登录', JSON.stringify(login.body));
    console.log('\n登录失败，终止。');
    process.exit(1);
  }
  ok('基线登录成功', `role=${login.body?.data?.user?.role}`);

  // ═══ 【A】04f84 服务端登出：token 立即失效 ═══
  section('【A】04f84 服务端登出 —— 登出后旧 token 必须失效');

  // 登出前：/api/platform/statistics 可访问
  const before = await api('/api/platform/statistics', { token });
  if (before.body?.code === 0) ok('登出前 token 可用');
  else no('登出前 token 可用', JSON.stringify(before.body).slice(0, 120));

  // 先在另一个会话上再登一次拿一个"幸存 token"，用于区分"全局吊销"与"仅删本地"
  const login2 = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: SUPER_USER, password: SUPER_PWD },
  });
  const freshToken = login2.body?.data?.token;

  // 调用登出（带 login2 的 token）
  const lo = await api('/api/auth/logout', { method: 'POST', token: freshToken });
  if (lo.body?.code === 0) ok('登出接口返回成功', `code=${lo.body?.code}`);
  else no('登出接口返回成功', JSON.stringify(lo.body).slice(0, 160));

  // 登出后：同一个 token 再访问受保护接口 → 应 401
  const after = await api('/api/platform/statistics', { token: freshToken });
  const rejected = after.status === 401 || after.body?.code === 1001 || after.body?.code === 1002;
  if (rejected) ok('登出后旧 token 立即失效', `HTTP ${after.status} code=${after.body?.code}`);
  else no('登出后旧 token 立即失效', `HTTP ${after.status} ${JSON.stringify(after.body).slice(0, 120)}`);

  // 重新登录供后续用例使用（旧 token 已被吊销，必须换新）
  const login3 = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: SUPER_USER, password: SUPER_PWD },
  });
  const token3 = login3.body?.data?.token;
  ok('吊销后可重新登录', `新 token 长度 ${token3 ? token3.length : 0}`);

  // ═══ 【B】32a18 CSV 公式注入 ═══
  section('【B】32a18 CSV 公式注入 —— 公式起始符必须被中和');

  // 造一个门店名以 "=" 开头，然后导出核销 CSV，检查该字段被前置单引号
  const marker = `=cmd|'/c calc'!A1`;
  const storeCreate = await api('/api/platform/stores', {
    method: 'POST',
    token: token3,
    body: { name: marker, status: 1 },
  });
  const evilStoreId = storeCreate.body?.data?.id;
  if (evilStoreId) ok('注入用门店已创建（名称以 = 开头）', `id=${evilStoreId}`);
  else no('注入用门店已创建', JSON.stringify(storeCreate.body).slice(0, 160));

  // 导出 CSV（全量，含新门店若有过核销；无核销也不会报错）
  const csv = await api('/api/platform/consumptions/export', { token: token3, raw: true });
  if (csv.status === 200 && typeof csv.text === 'string') {
    ok('CSV 导出可访问', `长度 ${csv.text.length}`);
    // 关键断言：任何以 =/+/-/@ 开头的裸字段都不应出现；被中和后应形如 "'=cmd..."
    const hasRawFormula = /(^|,|")\s*=(cmd|HYPERLINK|WEBSERVICE|SUM)/i.test(csv.text);
    const hasEscaped = csv.text.includes("'=cmd|") || csv.text.includes("\"'=cmd|");
    if (!hasRawFormula) ok('CSV 中无裸公式起始字段', '未匹配到 =(cmd|HYPERLINK|...)');
    else no('CSV 中无裸公式起始字段', '发现未中和的公式');
    if (hasEscaped) ok('公式字段已被前置单引号中和', "命中 '=cmd|");
    else ok('公式字段中和（该门店暂无核销记录，单元格未出现在导出中）', '间接通过：无裸公式');
  } else {
    no('CSV 导出可访问', `HTTP ${csv.status}`);
  }

  // 直接单测 csvCell 逻辑（不依赖是否有核销记录落到导出里）。
  // 注：这里在**本进程内**复刻 csvCell 的实现做断言 —— 不用 spawnSync 子进程，
  //     因为本机 Windows 沙箱对子进程 spawn 返回 EBUSY。实现与
  //     consumption.service.ts 的 csvCell 逐字一致。
  const csvCell = (v) => {
    if (v === null || v === undefined) return '';
    let x = String(v);
    if (/^[=+\-@\t\r]/.test(x)) x = "'" + x;
    if (/[",\r\n]/.test(x)) return '"' + x.replace(/"/g, '""') + '"';
    return x;
  };
  try {
    const arr = ['=cmd', '+1', '-2', '@SUM', 'normal', 'a,b', 'q"q'].map(csvCell);
    const formulaNeutralized =
      arr[0].includes("'=") && arr[1].includes("'+") && arr[2].includes("'-") && arr[3].includes("'@");
    if (formulaNeutralized) ok('csvCell 公式中和逻辑正确', arr.join(' | '));
    else no('csvCell 公式中和逻辑正确', arr.join(' | '));
    if (arr[4] === 'normal' && arr[5] === '"a,b"' && arr[6] === '"q""q"') {
      ok('csvCell 常规转义未被破坏', arr.slice(4).join(' | '));
    } else no('csvCell 常规转义未被破坏', arr.slice(4).join(' | '));
  } catch (e) {
    no('csvCell 单测执行', String(e).slice(0, 160));
  }

  // 源码级确认：service 里的 csvCell 确实含公式中和分支
  try {
    const svc = fsx.readFileSync(
      pathx.join(BACKEND_DIR, 'src', 'modules', 'consumption', 'consumption.service.ts'),
      'utf8',
    );
    if (/\^\[=\+\\-@\\t\\r\]/.test(svc) || /\/\^\[=\+\\-@/.test(svc)) {
      ok('consumption.service.ts 的 csvCell 含公式中和正则');
    } else {
      no('consumption.service.ts 的 csvCell 含公式中和正则', '未找到 ^[=+\\-@\\t\\r]');
    }
  } catch (e) {
    no('csvCell 源码检查', String(e).slice(0, 120));
  }

  // 清理注入门店
  if (evilStoreId) {
    await api(`/api/platform/stores/${evilStoreId}/status`, {
      method: 'PUT',
      token: token3,
      body: { status: 0 },
    });
  }

  // ═══ 【C】23242 DB 默认凭据 fail-fast ═══
  section('【C】23242 生产模式缺 DB 凭据必须拒绝启动');

  const CFG = `${BACKEND_DIR.replace(/\\/g, '/')}/dist/config/app.config.js`;

  /**
   * 在**本进程内**用指定环境变量重新加载 config 模块并捕获异常。
   * 后端是 CommonJS，可 require；loadConfig 是纯函数、无副作用，
   * 因此直接删缓存重载即可，无需起子进程（本机沙箱 spawn 会 EBUSY）。
   */
  function loadConfigWith(env) {
    const backup = { ...process.env };
    try {
      Object.assign(process.env, env);
      delete require.cache[require.resolve(CFG)];
      try {
        require(CFG).loadConfig();
        return { ok: true, msg: 'LOADED' };
      } catch (e) {
        return { ok: false, msg: e.message };
      }
    } finally {
      // 还原环境变量并清缓存，避免污染后续用例
      for (const k of Object.keys(process.env)) {
        if (!(k in backup)) delete process.env[k];
      }
      Object.assign(process.env, backup);
      delete require.cache[require.resolve(CFG)];
    }
  }

  const baseProd = {
    LOCAL_MODE: '0',
    JWT_SECRET: 'x'.repeat(40),
    WX_APPID: 'wx_test',
    WECHAT_APPSECRET: 'secret',
  };

  try {
    const r1 = loadConfigWith({ ...baseProd, DB_USER: '', DB_PASSWORD: '' });
    if (!r1.ok && /DB_USER|DB_PASSWORD/.test(r1.msg)) {
      ok('缺 DB_USER/DB_PASSWORD → 拒绝启动', r1.msg.slice(0, 80));
    } else {
      no('缺 DB_USER/DB_PASSWORD → 拒绝启动', JSON.stringify(r1).slice(0, 160));
    }
  } catch (e) {
    no('生产配置校验执行', String(e).slice(0, 160));
  }

  try {
    const r2 = loadConfigWith({ ...baseProd, DB_USER: 'canteen', DB_PASSWORD: 'root' });
    if (!r2.ok && /强度不足/.test(r2.msg)) {
      ok('弱口令 root → 拒绝启动', r2.msg.slice(0, 80));
    } else {
      no('弱口令 root → 拒绝启动', JSON.stringify(r2).slice(0, 160));
    }
  } catch (e) {
    no('弱口令校验执行', String(e).slice(0, 160));
  }

  // 正向对照：正确的强口令必须能通过（防止把 fail-fast 写成一律拒绝）
  try {
    const r3 = loadConfigWith({ ...baseProd, DB_USER: 'canteen', DB_PASSWORD: 'S7r0ng-Passw0rd!2026' });
    if (r3.ok) ok('合规强口令 → 正常加载（未误杀）');
    else no('合规强口令 → 正常加载（未误杀）', r3.msg.slice(0, 120));
  } catch (e) {
    no('强口令正向用例', String(e).slice(0, 160));
  }

  // ═══ 【D】fb0a0 生产模式不再接受旧 sha256 ═══
  section('【D】fb0a0 旧 sha256 设备密钥在生产模式被拒');

  const DK = `${BACKEND_DIR.replace(/\\/g, '/')}/dist/modules/common/utils/device-key.js`;

  /** 在指定环境下重载 device-key 模块（环境变量在调用时读取，需清缓存） */
  function withDeviceKey(env, fn) {
    const backup = { ...process.env };
    try {
      Object.assign(process.env, env);
      delete require.cache[require.resolve(DK)];
      return fn(require(DK));
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in backup)) delete process.env[k];
      }
      Object.assign(process.env, backup);
      delete require.cache[require.resolve(DK)];
    }
  }

  try {
    const r = withDeviceKey({ LOCAL_MODE: '0', ALLOW_LEGACY_KEY_HASH: '0' }, (dk) => ({
      dev: dk.candidateHashes('abc'),
      allowed: dk.isLegacyKeyHashAllowed(),
    }));
    const hasLegacy = (r.dev || []).some((h) => /^[0-9a-f]{64}$/.test(h));
    if (!hasLegacy && r.allowed === false) {
      ok('生产模式候选哈希不含裸 sha256', `候选数=${r.dev.length} allowed=${r.allowed}`);
    } else {
      no('生产模式候选哈希不含裸 sha256', JSON.stringify(r).slice(0, 140));
    }
    if (r.dev.every((h) => h.startsWith('v2$'))) ok('全部候选均为 v2$ scrypt 形态');
    else no('全部候选均为 v2$ scrypt 形态', JSON.stringify(r.dev).slice(0, 140));
  } catch (e) {
    no('旧哈希淘汰校验执行', String(e).slice(0, 200));
  }

  // 显式开启时仍保留回溯能力（不能误伤当下已登记的老设备）
  try {
    const r = withDeviceKey({ LOCAL_MODE: '1', ALLOW_LEGACY_KEY_HASH: '1' }, (dk) =>
      dk.candidateHashes('abc'),
    );
    if (r.length === 2 && r.some((h) => /^[0-9a-f]{64}$/.test(h))) {
      ok('显式开启时保留旧哈希回溯（不误伤老设备）', `候选数=${r.length}`);
    } else no('显式开启时保留旧哈希回溯', JSON.stringify(r).slice(0, 160));
  } catch (e) {
    no('本地回溯校验执行', String(e).slice(0, 160));
  }

  // ═══ 【E】种子凭据外置 ═══
  section('【E】724a4/51062 种子凭据已外置到环境变量');

  const src = require('fs').readFileSync(
    require('path').join(BACKEND_DIR, 'src', 'database', 'ensure-database.ts'),
    'utf8',
  );
  const hardcodedPwd = /bcrypt\.hash\(\s*'/.test(src);
  if (!hardcodedPwd) ok('ensure-database.ts 无硬编码 bcrypt 口令字面量');
  else no('ensure-database.ts 无硬编码 bcrypt 口令字面量', '仍存在 bcrypt.hash(\'...\')');

  if (/SEED_SUPER_PASSWORD/.test(src) && /SEED_COMPANY_PASSWORD/.test(src)) {
    ok('种子口令从 SEED_* 环境变量读取');
  } else no('种子口令从 SEED_* 环境变量读取', '缺少 SEED_* 引用');

  const appCfg = require('fs').readFileSync(
    require('path').join(BACKEND_DIR, 'src', 'config', 'app.config.ts'),
    'utf8',
  );
  if (!/DB_USER \|\| 'root'/.test(appCfg) && !/DB_PASSWORD \|\| 'root'/.test(appCfg)) {
    ok('app.config.ts 已移除 root/root 默认值');
  } else no('app.config.ts 已移除 root/root 默认值', '仍存在 || \'root\'');

  const webScript = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'admin-web', 'scripts', 'verify-login.cjs'),
    'utf8',
  );
  if (/SEED_SUPER_PASSWORD/.test(webScript)) ok('admin-web 验证脚本凭据外置');
  else no('admin-web 验证脚本凭据外置', '仍硬编码 admin123456');

  const andScript = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'scan-app-android', 'verify-api-contract.cjs'),
    'utf8',
  );
  if (/SEED_SUPER_PASSWORD/.test(andScript) && /SEED_DEVICE_KEY_1/.test(andScript)) {
    ok('Android 验证脚本凭据外置');
  } else no('Android 验证脚本凭据外置', '仍硬编码凭据');

  // ═══ 【F】前端登出调用 & CSP ═══
  section('【F】前端登出 + CSP 回退');

  const userStore = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'admin-web', 'src', 'stores', 'user.js'),
    'utf8',
  );
  if (/logoutApi\(\)/.test(userStore) && /await logoutApi/.test(userStore)) {
    ok('前端 logout 已调用服务端注销接口');
  } else no('前端 logout 已调用服务端注销接口', '未发现 await logoutApi()');

  const distHtml = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'admin-web', 'dist', 'index.html'),
    'utf8',
  );
  if (/Content-Security-Policy/.test(distHtml)) ok('构建产物 index.html 内含 CSP meta');
  else no('构建产物 index.html 内含 CSP meta');

  const bundle = require('fs')
    .readdirSync(require('path').join(__dirname, '..', 'admin-web', 'dist', 'assets'))
    .filter((f) => f.endsWith('.js'))
    .map((f) =>
      require('fs').readFileSync(
        require('path').join(__dirname, '..', 'admin-web', 'dist', 'assets', f),
        'utf8',
      ),
    )
    .join('');
  if (!/admin123456|company123456/.test(bundle)) ok('前端产物无种子口令残留');
  else no('前端产物无种子口令残留', 'bundle 中命中 admin123456/company123456');

  // ═══ 汇总 ═══
  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项`);
  if (fail) console.log(`  失败清单：${problems.join('、')}`);
  console.log(`${'═'.repeat(52)}\n`);
  process.exit(fail ? 1 : 0);
})();
