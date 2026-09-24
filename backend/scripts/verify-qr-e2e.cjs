/**
 * 端到端验证：从**运行中的真实接口**取二维码图片，再把它解码回来。
 *
 * 前面 verify-qr.cjs 验的是「编码器本身对不对」，
 * 这个脚本验的是「整条链路接对了没有」—— service 有没有真的把图片塞进响应、
 * 小程序拿到的东西是不是一张能扫的码。两件事缺一不可。
 *
 * 用法：先起服务，再 `SMOKE_BASE=http://127.0.0.1:3000 node scripts/verify-qr-e2e.cjs`
 */
const jsQR = require('jsqr');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`);
  }
};

/** 把 SVG data URL 还原成矩阵，再喂给 jsQR */
function decodeSvgDataUrl(url) {
  const PREFIX = 'data:image/svg+xml;base64,';
  if (!url || !url.startsWith(PREFIX)) throw new Error('不是 SVG data URL');
  const svg = Buffer.from(url.slice(PREFIX.length), 'base64').toString('utf8');

  // 从 viewBox 拿总尺寸、从 path 的方块边长拿 scale
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!vb) throw new Error('SVG 缺少 viewBox');
  const dim = Number(vb[1]);

  const rects = [...svg.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-\d+z/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    w: Number(m[3]),
  }));
  if (rects.length === 0) throw new Error('SVG 里没有模块方块');

  const scale = rects[0].w;
  const quiet = rects[0].x / scale;
  const n = dim / scale - quiet * 2;
  if (!Number.isInteger(n)) throw new Error(`码尺寸不是整数: ${n}`);

  const matrix = Array.from({ length: n }, () => new Array(n).fill(false));
  for (const r of rects) {
    matrix[r.y / scale - quiet][r.x / scale - quiet] = true;
  }

  /**
   * 渲染成 RGBA 交给解码器。
   *
   * ⚠️ 这里**必须按模块重建画布**，不能沿用 SVG 的像素尺寸 ——
   * 早期版本写的是 `px = dim * S` 却按 `(c + quiet) * scale * S` 定位，
   * 结果模块全挤在左上角、右下大片空白，解码器自然什么都读不到。
   * 画布边长只用 (n + 2*quiet) * S，与写入坐标同一套尺子。
   */
  const S = 8;
  const side = (n + quiet * 2) * S;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue;
      for (let dy = 0; dy < S; dy++) {
        for (let dx = 0; dx < S; dx++) {
          const x = (c + quiet) * S + dx;
          const y = (r + quiet) * S + dy;
          const i = (y * side + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { decoded: jsQR(data, side, side), modules: n, svg, matrix };
}

(async () => {
  console.log('\n═══ 二维码端到端验证（真实接口 → 解码）═══\n');
  console.log(`目标: ${BASE}\n`);

  // 1. 平台管理员登录
  const adm = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123456' },
  });
  const admToken = adm.body && adm.body.data && adm.body.data.token;
  check('平台管理员登录成功', !!admToken);
  if (!admToken) throw new Error('登录失败，后续无法继续');

  // 2. 员工登录：走小程序授权（code + phone），与 smoke 脚本一致
  const empLogin = await api('/api/auth/employee/login', {
    method: 'POST',
    body: { code: 'smoke-code-zhangsan', phone: '13900000001' },
  });
  const empToken = empLogin.body && empLogin.body.data && empLogin.body.data.token;
  check('员工登录成功', !!empToken, JSON.stringify(empLogin.body).slice(0, 160));

  if (!empToken) {
    console.log(`\n通过 ${pass} 项 / 失败 ${fail} 项（未拿到员工 token，提前结束）\n`);
    process.exit(1);
  }

  // 4. 取二维码 —— 这里是本次要验的核心
  //
  // ⚠️ 发码接口现在会拦截非核销时段。本脚本验的是"链路接对了没有"，
  // 不该依赖运行时刻，于是先把员工所属公司的启用规则临时停用
  // （无启用规则 = 不限制），验完再原样恢复。
  const compList = await api('/api/platform/companies', { token: admToken });
  const companies = Array.isArray(compList.body && compList.body.data)
    ? compList.body.data
    : (compList.body && compList.body.data && compList.body.data.list) || [];
  const targetCompany = companies.find((c) => c.name && c.name.includes('A')) || companies[0];
  const companyId = targetCompany && targetCompany.id;

  let pausedRules = [];
  if (companyId) {
    const rulesRes = await api(`/api/platform/rules?companyId=${companyId}`, { token: admToken });
    const rules = Array.isArray(rulesRes.body) ? rulesRes.body : (rulesRes.body && rulesRes.body.data) || [];
    pausedRules = rules.filter((r) => r.status === 1).map((r) => r.id);
    for (const id of pausedRules) {
      await api(`/api/platform/rules/${id}/status`, {
        method: 'PUT',
        token: admToken,
        body: { status: 0 },
      });
    }
  }

  const qr = await api('/api/employee/qrcode', { token: empToken });
  const data = qr.body && qr.body.data;
  check('GET /api/employee/qrcode 返回 200', qr.status === 200, `status=${qr.status}`);
  check('响应含 qrToken', !!(data && data.qrToken));
  check('响应含 qrImageUrl', !!(data && data.qrImageUrl));
  check(
    'qrImageUrl 是 SVG data URL',
    !!(data && typeof data.qrImageUrl === 'string' && data.qrImageUrl.startsWith('data:image/svg+xml;base64,')),
  );

  /** 恢复被临时停用的规则 */
  const restoreRules = async () => {
    for (const id of pausedRules) {
      await api(`/api/platform/rules/${id}/status`, {
        method: 'PUT',
        token: admToken,
        body: { status: 1 },
      });
    }
  };

  if (!data || !data.qrImageUrl) {
    await restoreRules();
    console.log(`\n通过 ${pass} 项 / 失败 ${fail} 项\n`);
    process.exit(1);
  }

  // 5. 把下发的图片解码回来 —— 证明「员工手机上显示的那张，是真能扫的」
  try {
    const { decoded, modules, svg } = decodeSvgDataUrl(data.qrImageUrl);
    check(`下发的图片可被解码器识别（${modules}x${modules} 模块）`, !!decoded);
    const expected = `TCV1:${data.qrToken}`;
    check(
      '扫码内容 = TCV1: 前缀 + qrToken',
      !!decoded && decoded.data === expected,
      decoded ? `得到 "${decoded.data.slice(0, 30)}…"` : '未解码',
    );

    // 6. 拿扫出来的内容回灌核销接口，验证闭环
    if (decoded) {
      const tokenFromScan = decoded.data.startsWith('TCV1:') ? decoded.data.slice(5) : decoded.data;
      check('扫出来的 token 与接口返回一致', tokenFromScan === data.qrToken);

      // 6. 拿扫出来的内容回灌核销接口，验证闭环。
      //    设备通道 /api/device/verify 不需要 JWT（核销员通道需要），
      //    用一个不存在的设备密钥，期望报「设备」相关错误而不是「二维码」相关 ——
      //    能走到设备校验，就证明扫出来的 token 已被系统当作有效二维码受理。
      const verifyRes = await api('/api/device/verify', {
        method: 'POST',
        body: { deviceKey: 'nonexistent-device-key', qrToken: tokenFromScan },
      });
      const msg = (verifyRes.body && verifyRes.body.message) || '';
      check(
        '扫出的 token 被系统当作有效二维码受理（报错指向设备而非二维码）',
        !/二维码无效|已过期|已使用/.test(msg),
        `message="${msg}"`,
      );
    }
  } catch (e) {
    check('下发的图片可被解码器识别', false, e.message);
  }

  // 恢复临时停用的时段规则，避免污染后续用例
  await restoreRules();

  console.log(`\n${'═'.repeat(46)}`);
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项`);
  console.log(`${'═'.repeat(46)}\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
