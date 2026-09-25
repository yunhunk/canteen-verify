#!/usr/bin/env node
/**
 * 核销设备密钥修复 —— 端到端验证
 *
 * 覆盖三个必须成立的断言：
 *   A. 新登记设备不受长度限制（回归：Data too long for column 'key_hash'）
 *   B. 换发密钥不受长度限制（回归同上）
 *   C. 旧 sha256 格式设备的密钥仍能通过鉴权（回归：biz 2006 设备密钥无效）
 *
 * 用法：
 *   SEED_PLATFORM_ADMIN=admin SEED_PLATFORM_PASSWORD=*** \
 *   SEED_DEVICE_KEY=device-key-demo-0001 \
 *   node verify-device-key-fix.cjs [BASE_URL]
 *
 * 凭据一律走环境变量，禁止硬编码（MonkeyScan 724a4/51062/50b9f/20652）。
 */
const BASE = (process.env.ONLINE_BASE || process.argv[2] || 'https://tuancan.gengle.xyz').replace(/\/$/, '');
const USER = process.env.SEED_PLATFORM_ADMIN || process.argv[3] || '';
const PASS = process.env.SEED_PLATFORM_PASSWORD || process.argv[4] || '';
const LEGACY_DEVICE_KEY = process.env.SEED_DEVICE_KEY || '';

if (!USER || !PASS) {
  console.error('缺少 SEED_PLATFORM_ADMIN / SEED_PLATFORM_PASSWORD（本脚本不内置任何凭据）');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const fails = [];

function ok(name, detail = '') {
  pass++;
  console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
}
function no(name, detail = '') {
  fail++;
  fails.push(name);
  console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json };
}

(async () => {
  console.log(`\n═══ 核销设备密钥修复验证 @ ${BASE} ═══\n`);

  // ── 登录取 token ──────────────────────────────────────────
  console.log('【0】平台管理员登录');
  const login = await req('POST', '/api/auth/admin/login', {
    body: { username: USER, password: PASS },
  });
  const token = login.json?.data?.token;
  if (!token) {
    no('管理员登录', `HTTP ${login.status} / ${JSON.stringify(login.json)}`);
    console.log('\n登录失败，后续无法继续。');
    process.exit(1);
  }
  ok('管理员登录', `role=${login.json.data.user.role}`);

  // ── A. 新登记设备 ─────────────────────────────────────────
  console.log('\n【A】新登记设备（回归 Data too long）');
  const devName = `自动化测试设备-${Date.now()}`;
  const created = await req('POST', '/api/platform/devices', {
    token,
    body: { name: devName },
  });
  const newDev = created.json?.data;
  if (newDev?.deviceKey) {
    ok('登记新设备成功', `id=${newDev.id} prefix=${newDev.keyPrefix}`);
    const keyLen = newDev.deviceKey.length;
    if (keyLen === 48) ok('密钥明文长度 48', `实际 ${keyLen}`);
    else no('密钥明文长度 48', `实际 ${keyLen}`);
  } else {
    no('登记新设备成功', `HTTP ${created.status} / ${JSON.stringify(created.json)}`);
  }

  // ── B. 换发密钥 ───────────────────────────────────────────
  console.log('\n【B】换发密钥（回归 Data too long）');
  if (newDev?.id) {
    const rotated = await req('POST', `/api/platform/devices/${newDev.id}/rotate-key`, {
      token,
    });
    const rk = rotated.json?.data;
    if (rk?.deviceKey) {
      ok('换发密钥成功', `新 prefix=${rk.keyPrefix}`);
      if (rk.deviceKey !== newDev.deviceKey) ok('新旧密钥不同（旧密钥已失效）');
      else no('新旧密钥不同', '新旧密钥相同，换发未生效');
    } else {
      no('换发密钥成功', `HTTP ${rotated.status} / ${JSON.stringify(rotated.json)}`);
    }
  } else {
    no('换发密钥成功', '前置步骤失败，跳过');
  }

  // ── C. 旧 sha256 设备密钥仍可鉴权 ─────────────────────────
  console.log('\n【C】旧 sha256 格式设备密钥鉴权（回归 biz 2006）');
  if (!LEGACY_DEVICE_KEY) {
    console.log('  ⏭  未设 SEED_DEVICE_KEY，跳过旧 sha256 鉴权断言');
  } else {
  // 该明文对应线上 id=1 设备的哈希（sha256 格式，库里 64 字符）
  const legacy = await req('POST', '/api/device/verify', {
    body: { deviceKey: LEGACY_DEVICE_KEY, qrToken: 'INVALID-TOKEN-PROBE' },
  });
  const errCode = legacy.json?.code;
  // 关键：若设备鉴权通过，会进入二维码校验并返回二维码相关错误（如 2001）；
  // 若鉴权失败则会返回 2006。断言不应是 2006。
  if (errCode === 2006) {
    no('旧 sha256 密钥通过设备鉴权', '仍返回 2006 设备密钥无效');
  } else if (errCode === undefined && legacy.status === 404) {
    no('旧 sha256 密钥通过设备鉴权', '接口路径 404，无法判定');
  } else {
    ok(
      '旧 sha256 密钥通过设备鉴权',
      `返回 code=${errCode}（非 2006 即鉴权已通过，进入后续校验）`,
    );
  }
  }

  // ── D. 新密钥同样可鉴权 ───────────────────────────────────
  console.log('\n【D】新格式密钥鉴权（v2$ scrypt）');
  // 用刚换发的密钥探测（若 B 失败则跳过）
  const rotatedKey = (await (async () => {
    if (!newDev?.id) return null;
    const again = await req('POST', `/api/platform/devices/${newDev.id}/rotate-key`, {
      token,
    });
    return again.json?.data?.deviceKey || null;
  })());
  if (rotatedKey) {
    const probe = await req('POST', '/api/device/verify', {
      body: { deviceKey: rotatedKey, qrToken: 'INVALID-TOKEN-PROBE' },
    });
    if (probe.json?.code === 2006) {
      no('新格式密钥通过设备鉴权', '返回 2006，说明写入/查询不一致');
    } else {
      ok('新格式密钥通过设备鉴权', `返回 code=${probe.json?.code}（非 2006 即已通过）`);
    }
  } else {
    no('新格式密钥通过设备鉴权', '无法取得新密钥，跳过');
  }

  // ── 清理：停用测试设备 ────────────────────────────────────
  console.log('\n【E】清理测试设备');
  if (newDev?.id) {
    const off = await req('PUT', `/api/platform/devices/${newDev.id}/status`, {
      token,
      body: { status: 0 },
    });
    if (off.json?.code === 0) ok('测试设备已停用', `id=${newDev.id}`);
    else no('测试设备已停用', `HTTP ${off.status}`);
  }

  // ── 汇总 ─────────────────────────────────────────────────
  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
  if (fail) console.log('失败项：\n' + fails.map((f) => '  - ' + f).join('\n'));
  console.log();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n验证脚本异常：', e.message);
  process.exit(1);
});
