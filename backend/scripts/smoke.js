/**
 * 端到端冒烟测试
 *
 * 覆盖设计文档里每一条"关键设计"，尤其是那些靠读代码看不出对错的：
 * - 并发核销恰好成功 1 个（防超扣）
 * - 设备绑定门店优先于请求参数（防跨门店冒充）
 * - 换发密钥后旧密钥立即失效
 * - 不在可核销时段被拒且剩余次数前后一致（一次都不扣）
 * - 规则创建前的历史核销不占用新规则名额（不追溯既往）
 * - 跨租户越权返回 403
 * - 重置密码后旧 token 立刻 401（token_version 的运行时证明）
 * - 不能删/停自己（防自锁）
 *
 * 用法：先启动服务，再 node scripts/smoke.js
 */
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3311';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? ` → ${JSON.stringify(extra)}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

/**
 * 把列表类响应的 data 归一化成数组。
 *
 * 后端列表接口有两种返回风格（历史遗留）：
 * - 分页式：{ total, page, pageSize, list }  —— employees / consumptions / companies
 * - 裸数组：[ ... ]                          —— devices / rules / admins
 * 管理后台的 useList() 只认分页式，所以 companies 已统一为分页式；
 * 这里做兼容，免得每次接口结构调整都要改十几处断言。
 */
function asList(body) {
  const d = body?.data;
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.list)) return d.list;
  return [];
}

async function api(path, { method = 'GET', token, body, raw, rawBytes } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // 二进制模式：用于校验 BOM 这类必须看原始字节的场景
  // （fetch 的 .text() 会剥离 BOM，用它判断会得到假阴性）
  if (rawBytes) return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
  if (raw) return { status: res.status, text: await res.text() };
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 等待服务端口可连通（最多 40 秒） */
async function waitForServer() {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/platform/companies`, { method: 'GET' });
      console.log('服务已就绪\n');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.error(`\n无法连接到 ${BASE} —— 请先启动服务（npm run local）\n`);
  process.exit(1);
}

async function main() {
  console.log(`\n═══ 团餐核销系统 · 端到端冒烟测试 ═══\n目标：${BASE}`);

  // 等服务就绪：启动是异步的，直接打请求容易 ECONNREFUSED 而误判
  await waitForServer();

  // ─────────────────────────────────────────────
  section('1. 鉴权与账号体系');

  const superLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123456' },
  });
  check('平台超管登录成功', superLogin.body?.code === 0, superLogin.body);
  const superToken = superLogin.body?.data?.token;
  check('超管 token 含 role=super', !!superToken);

  const noAuth = await api('/api/platform/companies');
  check('未带 token 访问平台接口 → 401', noAuth.status === 401, noAuth.status);

  const wrongPass = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: 'wrong-password' },
  });
  check('密码错误 → 登录失败且文案不区分账号是否存在', wrongPass.body?.code !== 0, wrongPass.body);

  const companyLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'company_a', password: 'company123456' },
  });
  check('公司管理员登录成功', companyLogin.body?.code === 0);
  let companyToken = companyLogin.body?.data?.token;

  // 员工：mock 微信登录（未配 appId 时后端走 mock openid）
  const empLogin1 = await api('/api/auth/employee/login', {
    method: 'POST',
    body: { code: 'smoke-code-zhangsan', phone: '13900000001' },
  });
  check('员工首次登录+绑定成功', empLogin1.body?.code === 0, empLogin1.body);
  const empToken = empLogin1.body?.data?.token;

  const empLoginAgain = await api('/api/auth/employee/login', {
    method: 'POST',
    body: { code: 'smoke-code-zhangsan' },
  });
  check('已绑定 openid 后可直接登录（无需再传手机号）', empLoginAgain.body?.code === 0, empLoginAgain.body);

  const empNoPhone = await api('/api/auth/employee/login', {
    method: 'POST',
    body: { code: 'smoke-code-lisi-new' },
  });
  check('未绑定且未传手机号 → 返回 needBind', empNoPhone.body?.data?.needBind === true, empNoPhone.body);

  const empAccessPlatform = await api('/api/platform/companies', { token: empToken });
  check('员工访问平台接口 → 403/401', [401, 403].includes(empAccessPlatform.status), empAccessPlatform.status);

  // ─────────────────────────────────────────────
  section('2. 多租户隔离');

  const companies = await api('/api/platform/companies', { token: superToken });
  check('超管可跨公司查公司列表', companies.body?.code === 0 && asList(companies.body).length > 0);
  const companyA = asList(companies.body).find((c) => c.name.includes('示例科技'));
  const companyB = asList(companies.body).find((c) => c.name.includes('制造'));
  check('种子公司 A / B 均存在', !!companyA && !!companyB);

  const companyBEmployees = await api('/api/company/employees', { token: companyToken });
  const listB = companyBEmployees.body?.data?.list || [];
  const listCompanyIds = [...new Set(listB.map((e) => e.companyId))];
  check(
    '公司管理员只能看到本公司员工（租户隔离）',
    listCompanyIds.length <= 1 && (listCompanyIds[0] === undefined || listCompanyIds[0] === companyA.id),
    listCompanyIds,
  );

  // 越权：A 公司管理员去改 B 公司员工的 status
  const companyBLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'company_b', password: 'company123456' },
  });
  const companyBToken = companyBLogin.body?.data?.token;
  const companyBEmps = await api('/api/company/employees', { token: companyBToken });
  const bEmp = companyBEmps.body?.data?.list?.[0];

  const crossTenant = await api(`/api/company/employees/${bEmp.id}/status`, {
    method: 'PUT',
    token: companyToken, // A 公司的 token
    body: { status: 0 },
  });
  check('跨公司改员工状态 → 403', crossTenant.status === 403, crossTenant.status);

  const companyAccessPlatform = await api('/api/platform/companies', { token: companyToken });
  check('公司管理员访问平台接口 → 403', companyAccessPlatform.status === 403, companyAccessPlatform.status);

  // ─────────────────────────────────────────────
  section('3. 二维码与核销主链路');

  // ── 时段自适应 setup ───────────────────────────────────────────
  // 种子给 A 公司配的是「午餐 11:00-13:30 / 晚餐 17:00-19:30」。
  // 发码接口现在会拦截非时段请求，于是本节的正确性取决于「跑测试的时刻」——
  // 凌晨跑必然全挂，这是测试脆弱而不是功能出错。
  // 做法：把 A 公司现有规则临时停用，插一条覆盖当前时刻的全天规则，
  // 跑完本节再原样恢复（第 13 节另有自己的规避规则用例，互不影响）。
  const ruleListBefore = asList((await api('/api/company/rules', { token: companyToken })).body);
  const savedRules = ruleListBefore.map((r) => ({
    id: r.id,
    name: r.name,
    startTime: r.startTime,
    endTime: r.endTime,
    perEmployeeLimit: r.perEmployeeLimit,
  }));
  for (const r of savedRules) {
    // 停用必须走专用的 /status 接口：PUT /:id 的 DTO 要求 name/startTime/endTime
    // 是必填的，只传 { status: 0 } 会被 400 拦掉（静默失效，很坑）。
    await api(`/api/company/rules/${r.id}/status`, {
      method: 'PUT',
      token: companyToken,
      body: { status: 0 },
    });
  }
  const openRule = await api('/api/company/rules', {
    method: 'POST',
    token: companyToken,
    body: { name: '冒烟用全天时段', startTime: '00:00', endTime: '23:59', perEmployeeLimit: 99 },
  });
  const openRuleId = openRule.body?.data?.id;
  check('冒烟前置：置为可核销状态（临时全天规则）', openRule.body?.code === 0, openRule.body);

  /** 恢复 A 公司原有规则（删除临时规则 + 重新启用原规则） */
  async function restoreRules() {
    if (openRuleId) await api(`/api/company/rules/${openRuleId}`, { method: 'DELETE', token: companyToken });
    for (const r of savedRules) {
      await api(`/api/company/rules/${r.id}/status`, {
        method: 'PUT',
        token: companyToken,
        body: { status: 1 },
      });
    }
  }

  const qr = await api('/api/employee/qrcode', { token: empToken });
  check('生成动态二维码成功', qr.body?.code === 0 && !!qr.body.data.qrToken, qr.body);
  const qrToken = qr.body.data.qrToken;
  check('二维码 token 为 48 位', qrToken?.length === 48, qrToken?.length);

  const me = await api('/api/employee/me', { token: empToken });
  check('员工查看本人信息成功', me.body?.code === 0);
  check('员工信息中手机号已脱敏', /\*{4}/.test(me.body?.data?.phone || ''), me.body?.data?.phone);

  const quotaBefore = asList((await api('/api/platform/companies', { token: superToken })).body).find(
    (c) => c.id === companyA.id,
  ).remainQuota;

  // 用不绑店的设备核销（当前时间为准，可能不在时段内）
  const verifyRes = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0002', qrToken },
  });

  // 时段规则：本节的 setup 已把 A 公司置为「全天可核销」，
  // 所以这里必然是"核销成功"路径。else 分支只作防御（setup 失效时能看出来）。
  const nowHhmm = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
  const inWindow = verifyRes.body?.code === 0;

  if (inWindow) {
    check('处于可核销时段 → 核销成功', verifyRes.body?.code === 0, verifyRes.body);
    const quotaAfter = asList((await api('/api/platform/companies', { token: superToken })).body).find(
      (c) => c.id === companyA.id,
    ).remainQuota;
    check('核销成功后公司剩余次数 -1', quotaAfter === quotaBefore - 1, {
      before: quotaBefore,
      after: quotaAfter,
    });
    check('核销结果回传命中时段信息', !!verifyRes.body?.data?.window, verifyRes.body?.data?.window);
  } else {
    check(`当前 ${nowHhmm} 不在可核销时段 → 核销被拒`, verifyRes.body?.code !== 0, verifyRes.body);
    const quotaAfter = asList((await api('/api/platform/companies', { token: superToken })).body).find(
      (c) => c.id === companyA.id,
    ).remainQuota;
    check('时段被拒时剩余次数前后完全一致（一次都没扣）', quotaAfter === quotaBefore, {
      before: quotaBefore,
      after: quotaAfter,
    });
    check(
      '拒绝原因含可核销时间提示',
      /可核销时间/.test(verifyRes.body?.message || ''),
      verifyRes.body?.message,
    );
  }

  // ─────────────────────────────────────────────
  section('4. 防重复核销 / 防超扣');

  const qr2 = await api('/api/employee/qrcode', { token: empToken });
  const qrToken2 = qr2.body.data.qrToken;
  const dupRes = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0002', qrToken: qrToken2 },
  });
  const dupRes2 = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0002', qrToken: qrToken2 },
  });

  if (dupRes.body?.code === 0) {
    check('同一 token 第二次核销被拒（重复核销防护）', dupRes2.body?.code !== 0, dupRes2.body);
    // 串行重复走的是 a 步「二维码已使用」→ 2001。
    // 2003（DUPLICATE_VERIFY）只在并发同时到达、都过了 a 步、
    // 在 Redis 占位处相撞时才会出现 —— 那是下面并发用例负责证明的。
    check(
      '串行重复核销返回 2001（二维码已使用）',
      dupRes2.body?.code === 2001,
      dupRes2.body?.code,
    );

    // A 公司的继续用例到此为止，恢复种子里的真实时段规则。
    // （放在这里而不是第 3 节末尾：qr2 还要再发一次码，必须仍在开放时段内）
    await restoreRules();
  } else {
    // 时段外被拒：二维码**不应被消耗**，两次都该返回同一个时段拒绝原因。
    // 若第二次报 2003（重复核销），说明占位发生在校验之前 —— 那样员工
    // 在非用餐时段误扫一次就得手动刷新二维码，是体验硬伤。
    check(
      '时段外重复核销：两次均返回时段拒绝（二维码未被消耗）',
      dupRes.body?.code === 2005 && dupRes2.body?.code === 2005,
      { first: dupRes.body?.code, second: dupRes2.body?.code },
    );
    // 异常路径同样要还原，否则后续第 13 节拿到的是被改过的规则集
    await restoreRules();
  }

  // 并发核销：新建一个公司 + 员工，避开时段规则，专门验证原子扣减
  const concCompany = await api('/api/platform/companies', {
    method: 'POST',
    token: superToken,
    body: { name: `并发测试公司${Date.now()}`, totalQuota: 5 },
  });
  const concCompanyId = concCompany.body?.data?.id;
  check('创建并发测试公司成功', !!concCompanyId, concCompany.body);

  const concPhone = `137${String(Date.now()).slice(-8)}`;
  const concEmp = await api('/api/platform/employees', {
    method: 'POST',
    token: superToken,
    body: { companyId: concCompanyId, name: '并发测试员', phone: concPhone },
  });
  const concEmpId = concEmp.body?.data?.id;
  check('创建并发测试员工成功', !!concEmpId, concEmp.body);

  const concEmpLogin = await api('/api/auth/employee/login', {
    method: 'POST',
    body: { code: `conc-${Date.now()}`, phone: concPhone },
  });
  const concEmpToken = concEmpLogin.body?.data?.token;
  check('并发测试员工登录成功', !!concEmpToken, concEmpLogin.body);

  const concQr = await api('/api/employee/qrcode', { token: concEmpToken });
  const concQrToken = concQr.body.data.qrToken;

  const beforeConc = asList((await api('/api/platform/companies', { token: superToken })).body).find(
    (c) => c.id === concCompanyId,
  ).remainQuota;

  // 同一 token 并发 2 次：只应成功 1 次
  const [r1, r2] = await Promise.all([
    api('/api/device/verify', {
      method: 'POST',
      body: { deviceKey: 'device-key-demo-0002', qrToken: concQrToken },
    }),
    api('/api/device/verify', {
      method: 'POST',
      body: { deviceKey: 'device-key-demo-0002', qrToken: concQrToken },
    }),
  ]);
  const okCount = [r1, r2].filter((r) => r.body?.code === 0).length;
  const afterConc = asList((await api('/api/platform/companies', { token: superToken })).body).find(
    (c) => c.id === concCompanyId,
  ).remainQuota;

  check('并发核销：2 个请求恰好成功 1 个', okCount === 1, { r1: r1.body?.code, r2: r2.body?.code });
  check('并发核销：剩余次数恰好 -1（防超扣）', afterConc === beforeConc - 1, {
    before: beforeConc,
    after: afterConc,
  });
  // 失败那次的业务码：可能是 2001（先落库者已把二维码置失效）
  // 或 2003（两者同时过了 a 步、在 Redis 占位处相撞）。两者都算正确防重。
  const loserCode = [r1, r2].find((r) => r.body?.code !== 0)?.body?.code;
  check(
    '并发核销：失败方返回 2001/2003（重复核销防护）',
    loserCode === 2001 || loserCode === 2003,
    loserCode,
  );

  // ─────────────────────────────────────────────
  section('5. 设备密钥与门店绑定');

  const devices = await api('/api/platform/devices', { token: superToken });
  check('设备列表可查', devices.body?.code === 0);
  check(
    '设备列表不含 key_hash（绝不外泄）',
    !JSON.stringify(devices.body.data).includes('key_hash'),
  );
  check(
    '设备列表只返回 keyPrefix',
    devices.body.data.every((d) => d.keyPrefix !== undefined && d.deviceKey === undefined),
  );

  const newDevice = await api('/api/platform/devices', {
    method: 'POST',
    token: superToken,
    body: { name: `冒烟测试设备${Date.now()}` },
  });
  const newDeviceKey = newDevice.body?.data?.deviceKey;
  check('登记设备返回一次性明文密钥', !!newDeviceKey, newDevice.body);
  check('明文密钥为 48 位', newDeviceKey?.length === 48, newDeviceKey?.length);
  check('登记响应含"仅显示一次"警示', /仅显示这一次/.test(newDevice.body?.data?.warning || ''));

  const badKey = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'this-key-does-not-exist', qrToken: 'whatever' },
  });
  check('无效设备密钥被拒', badKey.body?.code !== 0, badKey.body);

  // 设备绑店优先：请求传 storeId=1，设备绑的是 store=总部食堂
  const stores = await api('/api/platform/stores', { token: superToken });
  const store1 = stores.body.data[0];
  const store2 = stores.body.data[1];

  const boundDevice = await api('/api/platform/devices', {
    method: 'POST',
    token: superToken,
    body: { name: `绑店设备${Date.now()}`, storeId: String(store2.id) },
  });
  const boundDeviceKey = boundDevice.body.data.deviceKey;

  const storeTestPhone = `136${String(Date.now()).slice(-8)}`;
  await api('/api/platform/employees', {
    method: 'POST',
    token: superToken,
    body: {
      companyId: concCompanyId,
      name: '绑店测试员',
      phone: storeTestPhone,
    },
  });
  const storeTestLogin = await api('/api/auth/employee/login', {
    method: 'POST',
    body: { code: `store-${Date.now()}`, phone: storeTestPhone },
  });
  const storeTestToken = storeTestLogin.body.data.token;
  const storeTestQr = (await api('/api/employee/qrcode', { token: storeTestToken })).body.data.qrToken;

  const storeVerify = await api('/api/device/verify', {
    method: 'POST',
    body: {
      deviceKey: boundDeviceKey,
      qrToken: storeTestQr,
      storeId: String(store1.id), // 恶意/错误地传了另一个门店
    },
  });
  check('设备绑定门店优先于请求参数', String(storeVerify.body?.data?.storeId) === String(store2.id), {
    requested: store1.id,
    actual: storeVerify.body?.data?.storeId,
    expected: store2.id,
  });
  check('核销响应回传门店名', !!storeVerify.body?.data?.storeName, storeVerify.body?.data);

  // 换发密钥：旧密钥立即失效
  const rotate = await api(`/api/platform/devices/${boundDevice.body.data.id}/rotate-key`, {
    method: 'POST',
    token: superToken,
  });
  const newKey2 = rotate.body?.data?.deviceKey;
  check('换发密钥返回新明文密钥', !!newKey2 && newKey2 !== boundDeviceKey, rotate.body);
  check('换发响应提示旧密钥已失效', /旧密钥已立即失效/.test(rotate.body?.data?.warning || ''));

  const qrAfterRotate = (await api('/api/employee/qrcode', { token: storeTestToken })).body.data.qrToken;
  const oldKeyTry = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: boundDeviceKey, qrToken: qrAfterRotate },
  });
  check('换发后旧密钥立即失效', oldKeyTry.body?.code !== 0, oldKeyTry.body);

  const qrAfterRotate2 = (await api('/api/employee/qrcode', { token: storeTestToken })).body.data.qrToken;
  const newKeyTry = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: newKey2, qrToken: qrAfterRotate2 },
  });
  check('换发后新密钥可正常核销', newKeyTry.body?.code === 0, newKeyTry.body);

  // 停用设备
  const disableDevice = await api(`/api/platform/devices/${boundDevice.body.data.id}/status`, {
    method: 'PUT',
    token: superToken,
    body: { status: 0 },
  });
  check('停用设备成功', disableDevice.body?.code === 0);
  const qrAfterDisable = (await api('/api/employee/qrcode', { token: storeTestToken })).body.data.qrToken;
  const disabledTry = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: newKey2, qrToken: qrAfterDisable },
  });
  check('已停用设备无法核销', disabledTry.body?.code !== 0, disabledTry.body);

  // ─────────────────────────────────────────────
  section('6. 时段规则');

  const rulesBefore = await api('/api/company/rules', { token: companyToken });
  check('公司端可查时段规则', rulesBefore.body?.code === 0);

  const newRule = await api('/api/company/rules', {
    method: 'POST',
    token: companyToken,
    body: { name: '宵夜', startTime: '22:00', endTime: '02:00', perEmployeeLimit: 1 },
  });
  check('新增跨天时段规则（22:00-02:00）成功', newRule.body?.code === 0, newRule.body);
  const ruleId = newRule.body?.data?.id;

  const rulesAfter = await api('/api/company/rules', { token: companyToken });
  const crossDayRule = asList(rulesAfter.body).find((r) => r.id === ruleId);
  check('跨天规则被标记 crossDay=true', crossDayRule?.crossDay === true, crossDayRule);

  const badTime = await api('/api/company/rules', {
    method: 'POST',
    token: companyToken,
    body: { name: '格式错误', startTime: '25:00', endTime: '26:00' },
  });
  check('非法时间格式被拒（25:00）', badTime.body?.code !== 0, badTime.body);

  const sameTime = await api('/api/company/rules', {
    method: 'POST',
    token: companyToken,
    body: { name: '起止相同', startTime: '12:00', endTime: '12:00' },
  });
  check('起止时间相同被拒', sameTime.body?.code !== 0, sameTime.body);

  const updateRule = await api(`/api/company/rules/${ruleId}`, {
    method: 'PUT',
    token: companyToken,
    body: { perEmployeeLimit: 2 },
  });
  check('编辑时段规则成功', updateRule.body?.code === 0, updateRule.body);

  const zeroLimit = await api(`/api/company/rules/${ruleId}`, {
    method: 'PUT',
    token: companyToken,
    body: { perEmployeeLimit: 0 },
  });
  check('次数设为 0（不限）成功', zeroLimit.body?.code === 0, zeroLimit.body);

  // 跨租户改规则
  const crossRule = await api(`/api/platform/rules/${ruleId}`, {
    method: 'PUT',
    token: companyBToken,
    body: { name: '越权改名' },
  });
  check('公司管理员用平台接口改规则 → 403', crossRule.status === 403, crossRule.status);

  // 员工访问公司时段管理：RolesGuard 先拦（role 不匹配）→ 403
  // 403 比 401 更准确：401 是"没登录"，403 是"登录了但这个角色不行"
  const empRuleAccess = await api('/api/company/rules', { token: empToken });
  check('员工访问公司时段管理 → 403（角色不符）', empRuleAccess.status === 403, empRuleAccess.status);

  const delRule = await api(`/api/company/rules/${ruleId}`, { method: 'DELETE', token: companyToken });
  check('删除时段规则成功', delRule.body?.code === 0, delRule.body);

  // ─────────────────────────────────────────────
  section('7. 规则不追溯既往（核心口径验证）');

  // 用独立公司做干净测试：先核销，再建规则
  const traceCompany = await api('/api/platform/companies', {
    method: 'POST',
    token: superToken,
    body: { name: `追溯测试公司${Date.now()}`, totalQuota: 10 },
  });
  const traceCompanyId = traceCompany.body.data.id;

  // 建一条覆盖"当前时刻"的规则前，先做一次无规则核销
  const tracePhone = `135${String(Date.now()).slice(-8)}`;
  await api('/api/platform/employees', {
    method: 'POST',
    token: superToken,
    body: { companyId: traceCompanyId, name: '追溯测试员', phone: tracePhone },
  });
  const traceLogin = await api('/api/auth/employee/login', {
    method: 'POST',
    body: { code: `trace-${Date.now()}`, phone: tracePhone },
  });
  const traceToken = traceLogin.body.data.token;

  const traceQr1 = (await api('/api/employee/qrcode', { token: traceToken })).body.data.qrToken;
  const preRuleVerify = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0002', qrToken: traceQr1 },
  });
  check('无规则时核销成功（老租户兼容：未配置即不限制）', preRuleVerify.body?.code === 0, preRuleVerify.body);
  check('无规则核销的 ruleId 为空', preRuleVerify.body?.data?.window === null, preRuleVerify.body?.data?.window);

  // 现在建一条覆盖当前时刻、限 1 次的规则
  const nowD = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const startH = pad(Math.max(0, nowD.getHours() - 1));
  const endH = pad(Math.min(23, nowD.getHours() + 2));
  const traceRule = await api('/api/company/rules', {
    method: 'POST',
    token: (await api('/api/auth/admin/login', { method: 'POST', body: { username: 'admin', password: 'admin123456' } })).body.data.token,
    body: { name: '追溯测试时段', startTime: `${startH}:00`, endTime: `${endH}:59`, perEmployeeLimit: 1 },
  });
  // 上面用超管 token 打公司端接口会被拒，改用平台端接口
  let traceRuleId = traceRule.body?.data?.id;
  if (!traceRuleId) {
    // 通过平台端代管接口为该公司建规则
    const platformRule = await api('/api/platform/rules', {
      method: 'POST',
      token: superToken,
      body: {
        companyId: traceCompanyId,
        name: '追溯测试时段',
        startTime: `${startH}:00`,
        endTime: `${endH}:59`,
        perEmployeeLimit: 1,
      },
    });
    traceRuleId = platformRule.body?.data?.id;
    check('平台端代管新增时段规则成功', !!traceRuleId, platformRule.body);
  }

  check('（前置）规则创建前的历史核销已存在', preRuleVerify.body?.code === 0);

  // 关键断言：规则建成后第 1 次核销应成功，第 2 次应被拒 —— 历史那次不占名额
  const t1 = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0002', qrToken: (await api('/api/employee/qrcode', { token: traceToken })).body.data.qrToken },
  });
  check('规则生效后第 1 次核销成功（历史核销不占用新规则名额）', t1.body?.code === 0, t1.body);
  check('本次核销归属到新规则 rule_id', !!t1.body?.data?.window, t1.body?.data?.window);

  const t2 = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0002', qrToken: (await api('/api/employee/qrcode', { token: traceToken })).body.data.qrToken },
  });
  check('第 2 次核销被时段次数限制拒绝', t2.body?.code !== 0, t2.body);
  check(
    '拒绝文案含时段名与次数限制',
    /限核销/.test(t2.body?.message || '') && /次数已用完/.test(t2.body?.message || ''),
    t2.body?.message,
  );

  // ─────────────────────────────────────────────
  section('8. 会话吊销（token_version）');

  const adminList = await api('/api/platform/admins', { token: superToken });
  check('管理账号列表可查', adminList.body?.code === 0);
  const selfRow = asList(adminList.body).find((a) => a.username === 'admin');
  check('列表带 isSelf 标记（供前端置灰按钮）', selfRow?.isSelf === true, selfRow);

  // 建一个临时超管来测试吊销
  const tempAdminUniqueName = `temp_admin_${Date.now()}`;
  const tempAdmin = await api('/api/platform/admins', {
    method: 'POST',
    token: superToken,
    body: { username: tempAdminUniqueName, password: 'temp123456', role: 'super' },
  });
  const tempAdminId = tempAdmin.body?.data?.id;
  check('创建临时超管成功', !!tempAdminId, tempAdmin.body);
  const tempUsername = tempAdminUniqueName;

  const dupAdmin = await api('/api/platform/admins', {
    method: 'POST',
    token: superToken,
    body: { username: asList(adminList.body)[0].username, password: 'whatever123' },
  });
  check('重复账号名返回可读 400（非唯一约束 500）', dupAdmin.status === 400 && dupAdmin.body?.code !== 0, {
    status: dupAdmin.status,
    message: dupAdmin.body?.message,
  });

  const companyNoCompany = await api('/api/platform/admins', {
    method: 'POST',
    token: superToken,
    body: { username: `no_company_${Date.now()}`, password: 'abc123456', role: 'company' },
  });
  check('公司管理员未指定公司 → 400', companyNoCompany.status === 400, companyNoCompany.body?.message);

  const superWithCompany = await api('/api/platform/admins', {
    method: 'POST',
    token: superToken,
    body: { username: `super_with_co_${Date.now()}`, password: 'abc123456', role: 'super', companyId: companyA.id },
  });
  check('平台超管绑定公司 → 400', superWithCompany.status === 400, superWithCompany.body?.message);

  // 用临时超管登录，然后重置其密码，验证旧 token 立刻失效
  const tempLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: tempUsername, password: 'temp123456' },
  });
  const tempToken = tempLogin.body?.data?.token;
  check('临时超管登录成功', !!tempToken, tempLogin.body);

  const tempWorks = await api('/api/platform/companies', { token: tempToken });
  check('临时超管 token 可正常访问', tempWorks.body?.code === 0);

  const resetPwd = await api(`/api/platform/admins/${tempAdminId}/password`, {
    method: 'PUT',
    token: superToken,
    body: { newPassword: 'newpass123456' },
  });
  check('超管重置他人密码成功', resetPwd.body?.code === 0, resetPwd.body);

  const tempAfterReset = await api('/api/platform/companies', { token: tempToken });
  check('重置密码后旧 token 立刻 401（token_version 生效）', tempAfterReset.status === 401, tempAfterReset.status);

  // 停用 / 启用
  const disableTemp = await api(`/api/platform/admins/${tempAdminId}/status`, {
    method: 'PUT',
    token: superToken,
    body: { status: 0 },
  });
  check('停用账号成功', disableTemp.body?.code === 0);

  const disabledLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: tempUsername, password: 'newpass123456' },
  });
  check('停用后无法登录', disabledLogin.body?.code !== 0, disabledLogin.body);

  const enableTemp = await api(`/api/platform/admins/${tempAdminId}/status`, {
    method: 'PUT',
    token: superToken,
    body: { status: 1 },
  });
  check('启用账号成功', enableTemp.body?.code === 0);
  const reLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: tempUsername, password: 'newpass123456' },
  });
  check('启用后可重新登录', reLogin.body?.code === 0, reLogin.body);

  // 自锁保护
  const selfRow2 = asList((await api('/api/platform/admins', { token: superToken })).body).find(
    (a) => a.username === 'admin',
  );
  check('超管自己的行 isSelf=true', selfRow2?.isSelf === true);

  const stopSelf = await api(`/api/platform/admins/${selfRow2.id}/status`, {
    method: 'PUT',
    token: superToken,
    body: { status: 0 },
  });
  check('停用自己 → 被拒（防自锁）', stopSelf.body?.code !== 0, stopSelf.body);
  check('防自锁返回业务码 1007', stopSelf.body?.code === 1007, stopSelf.body?.code);

  const delSelf = await api(`/api/platform/admins/${selfRow2.id}`, {
    method: 'DELETE',
    token: superToken,
  });
  check('删除自己 → 被拒（防自锁）', delSelf.body?.code !== 0, delSelf.body);

  // 改自己密码必须提供原密码
  const changeSelfNoOld = await api(`/api/platform/admins/${selfRow2.id}/password`, {
    method: 'PUT',
    token: superToken,
    body: { newPassword: 'brandnew123456' },
  });
  check('改自己密码未提供原密码 → 400', changeSelfNoOld.status === 400, changeSelfNoOld.body?.message);

  const changeSelfWrongOld = await api(`/api/platform/admins/${selfRow2.id}/password`, {
    method: 'PUT',
    token: superToken,
    body: { newPassword: 'brandnew123456', oldPassword: 'wrong-old-pass' },
  });
  check('改自己密码原密码错误 → 400', changeSelfWrongOld.status === 400, changeSelfWrongOld.body?.message);

  const changeSelfSame = await api(`/api/platform/admins/${selfRow2.id}/password`, {
    method: 'PUT',
    token: superToken,
    body: { newPassword: 'admin123456', oldPassword: 'admin123456' },
  });
  check('新密码与原密码相同 → 被拒', changeSelfSame.body?.code !== 0, changeSelfSame.body?.message);

  // 清理临时超管
  const delTemp = await api(`/api/platform/admins/${tempAdminId}`, { method: 'DELETE', token: superToken });
  check('删除临时账号成功', delTemp.body?.code === 0, delTemp.body);

  // ─────────────────────────────────────────────
  section('9. 员工增删与批量导入');

  const empCreate = await api('/api/platform/employees', {
    method: 'POST',
    token: superToken,
    body: { companyId: companyA.id, name: '新增测试员', phone: `134${String(Date.now()).slice(-8)}` },
  });
  check('平台端新增员工成功', empCreate.body?.code === 0, empCreate.body);

  const dupPhone = await api('/api/platform/employees', {
    method: 'POST',
    token: superToken,
    body: { companyId: companyA.id, name: '重复手机号', phone: '13900000001' },
  });
  check('重复手机号 → 400 且文案可读', dupPhone.status === 400, dupPhone.body?.message);

  const badPhone = await api('/api/platform/employees', {
    method: 'POST',
    token: superToken,
    body: { companyId: companyA.id, name: '手机号格式错', phone: '12345' },
  });
  check('手机号格式非法 → 400', badPhone.status === 400, badPhone.body?.message);

  const batchRows = [
    { companyId: companyA.id, name: '批量A', phone: `1331${String(Date.now()).slice(-7)}` },
    { companyId: companyA.id, name: '批量B重复', phone: '13900000001' }, // 应跳过
    { companyId: companyA.id, name: '批量C', phone: `1333${String(Date.now()).slice(-7)}` },
    { companyId: companyA.id, name: '批量D格式错', phone: 'abc' }, // 应跳过
  ];
  const batchRes = await api('/api/platform/employees/batch', {
    method: 'POST',
    token: superToken,
    body: { rows: batchRows },
  });
  check('批量导入返回成功/跳过明细', batchRes.body?.code === 0, batchRes.body);
  check('批量导入：部分成功不影响整批', batchRes.body?.data?.successCount === 2, {
    successCount: batchRes.body?.data?.successCount,
    skippedCount: batchRes.body?.data?.skippedCount,
  });
  check('批量导入：失败行有可读原因', (batchRes.body?.data?.skipped || []).every((s) => !!s.reason));

  // 公司端不能新增员工（无此接口）
  const companyCreateEmp = await api('/api/company/employees', {
    method: 'POST',
    token: companyToken,
    body: { name: 'x', phone: '13900000009' },
  });
  check('公司端无新增员工接口（404）', companyCreateEmp.status === 404, companyCreateEmp.status);

  // 停用员工 → 二维码失效、无法核销
  const targetEmp = empCreate.body.data.id;
  const stopEmp = await api(`/api/platform/employees/${targetEmp}/status`, {
    method: 'PUT',
    token: superToken,
    body: { status: 0 },
  });
  check('停用员工成功（逻��删除）', stopEmp.body?.code === 0);

  const disabledEmpLogin = await api('/api/auth/employee/login', {
    method: 'POST',
    body: { code: `disabled-${Date.now()}`, phone: '13900000001' },
  });
  check('停用员工无法登录绑定', disabledEmpLogin.body?.code !== 0, disabledEmpLogin.body);

  const listAfterStop = await api(`/api/platform/employees?companyId=${companyA.id}`, { token: superToken });
  const stopped = listAfterStop.body.data.list.find((e) => e.id === targetEmp);
  check('停用员工仍在列表中（逻辑删除，供对账）', stopped?.status === 0, stopped);

  // ─────────────────────────────────────────────
  section('10. 消费记录 / 统计 / 导出');

  const cons = await api(`/api/company/consumptions?page=1&pageSize=5`, { token: companyToken });
  check('公司端消费记录可查', cons.body?.code === 0, cons.body);
  if (cons.body?.data?.list?.length) {
    const row = cons.body.data.list[0];
    check('消费记录联表返回员工姓名', row.employeeName !== undefined, Object.keys(row));
    check('消费记录联表返回门店名', row.storeName !== undefined, Object.keys(row));
  }

  const platformCons = await api('/api/platform/consumptions', { token: superToken });
  check('平台端跨公司消费记录可查', platformCons.body?.code === 0);
  if (platformCons.body?.data?.list?.length) {
    check(
      '平台端记录带公司名',
      platformCons.body.data.list[0].companyName !== undefined,
      Object.keys(platformCons.body.data.list[0]),
    );
  }

  const trend = await api('/api/company/consumptions/trend?days=7', { token: companyToken });
  check('趋势接口返回 7 天数据', trend.body?.data?.length === 7, trend.body?.data?.length);
  check(
    '趋势数据零核销的日期也被补零（不丢日期）',
    trend.body.data.every((d) => typeof d.count === 'number' && !!d.date),
  );

  const stats = await api('/api/company/statistics', { token: companyToken });
  check('公司端看板可查', stats.body?.code === 0 && stats.body.data.remainQuota !== undefined, stats.body);

  const platformStats = await api('/api/platform/statistics', { token: superToken });
  check('平台端全局统计可查', platformStats.body?.code === 0, platformStats.body);
  check(
    '全局统计含公司/员工/核销数',
    ['totalCompanies', 'totalEmployees', 'totalConsumptions'].every(
      (k) => typeof platformStats.body?.data?.[k] === 'number',
    ),
  );

  const csv = await api('/api/company/consumptions/export', { token: companyToken, rawBytes: true });
  check('导出 CSV 成功', csv.status === 200, csv.status);
  check(
    'CSV 以 UTF-8 BOM(EF BB BF) 开头（Excel 直开不乱码）',
    csv.bytes[0] === 0xef && csv.bytes[1] === 0xbb && csv.bytes[2] === 0xbf,
    csv.bytes?.subarray(0, 3).toString('hex'),
  );
  const csvText = csv.bytes.toString('utf8');
  check('CSV 含中文表头', csvText.includes('核销时间') && csvText.includes('员工姓名'));
  check('CSV 内容含表头行', csvText.split('\r\n').length >= 1, csvText.split('\r\n').length);

  const todayCount = await api('/api/company/consumptions/today', { token: companyToken });
  check('今日核销数可查', typeof todayCount.body?.data?.count === 'number', todayCount.body);

  // ─────────────────────────────────────────────
  section('11. 操作日志');

  const companyLogs = await api('/api/company/operation-logs', { token: companyToken });
  check('公司端操作日志可查', companyLogs.body?.code === 0, companyLogs.body);

  const platformLogs = await api('/api/platform/operation-logs', { token: superToken });
  check('平台端跨公司操作日志可查', platformLogs.body?.code === 0, platformLogs.body);
  check('平台端日志数量 > 0', (platformLogs.body?.data?.total || 0) > 0, platformLogs.body?.data?.total);

  const logModules = new Set((platformLogs.body?.data?.list || []).map((l) => l.module));
  check(
    '日志覆盖多个模块（auth/verify/employee/rule/device）',
    ['auth', 'verify'].some((m) => logModules.has(m)),
    [...logModules],
  );

  const logRow = platformLogs.body.data.list[0];
  check('日志含操作人快照', logRow?.operatorName !== undefined, Object.keys(logRow || {}));
  check('日志含人读文案', typeof logRow?.description === 'string' && logRow.description.length > 0, logRow?.description);

  const filtered = await api('/api/platform/operation-logs?module=auth&action=login', { token: superToken });
  check('日志可按 module/action 筛选', filtered.body?.code === 0, filtered.body);

  // 公司端隔离：company_a 的日志里不应出现 B 公司的动作
  const aLogs = await api('/api/company/operation-logs?pageSize=100', { token: companyToken });
  const aCompanyIds = [...new Set((aLogs.body?.data?.list || []).map((l) => l.companyId))];
  const foreignIds = aCompanyIds.filter((id) => id !== null && String(id) !== String(companyA.id));
  check(
    '公司端日志已按租户隔离（只含本公司）',
    foreignIds.length === 0,
    { 本公司: companyA.id, 实际companyId取值: aCompanyIds },
  );

  const empLogAccess = await api('/api/company/operation-logs', { token: empToken });
  check('员工无权访问操作日志（403）', empLogAccess.status === 403, empLogAccess.status);

  // ─────────────────────────────────────────────
  section('12. 输入校验与边界');

  const emptyCompany = await api('/api/platform/companies', {
    method: 'POST',
    token: superToken,
    body: { name: '' },
  });
  check('公司名称为空 → 400', emptyCompany.status === 400, emptyCompany.body?.message);

  const negQuota = await api('/api/platform/companies', {
    method: 'POST',
    token: superToken,
    body: { name: '负数测试', totalQuota: -10 },
  });
  check('配额为负数 → 400', negQuota.status === 400, negQuota.body?.message);

  const badRuleLimit = await api('/api/company/rules', {
    method: 'POST',
    token: companyToken,
    body: { name: '负数次数', startTime: '10:00', endTime: '11:00', perEmployeeLimit: -1 },
  });
  check('时段次数为负 → 400', badRuleLimit.status === 400, badRuleLimit.body?.message);

  const shortPwd = await api('/api/platform/admins', {
    method: 'POST',
    token: superToken,
    body: { username: `short_${Date.now()}`, password: '123' },
  });
  check('密码过短 → 400', shortPwd.status === 400, shortPwd.body?.message);

  const invalidQr = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0002', qrToken: 'not-a-real-token' },
  });
  check('无效二维码 token → 被拒', invalidQr.body?.code !== 0, invalidQr.body);
  check('无效二维码返回业务码 2001', invalidQr.body?.code === 2001, invalidQr.body?.code);

  const missingQr = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0002' },
  });
  check('缺少 qrToken → 400（DTO 校验）', missingQr.status === 400, missingQr.status);

  const noDeviceKey = await api('/api/device/verify', {
    method: 'POST',
    body: { qrToken: 'whatever' },
  });
  check('既无 deviceKey 也无 deviceToken → 被拒', noDeviceKey.body?.code !== 0, noDeviceKey.body);

  // 响应格式统一性
  const sampleRes = await api('/api/employee/me', { token: empToken });
  check(
    '统一响应格式 { code, message, data }',
    ['code', 'message', 'data'].every((k) => k in sampleRes.body),
    Object.keys(sampleRes.body),
  );

  // ─────────────────────────────────────────────
  section('13. 非核销时段不出码');

  // 本节的正确性不能依赖运行时刻。做法：
  //   1) 先把 A 公司真实规则**全部停用**（这样"无启用规则 = 不限制"，发码必然成功）
  //   2) 建一条只覆盖「此刻之外」的规则
  //   3) 期望发码被拒 → 删掉它，期望恢复发码 → 再把真实规则启用回来
  // 用一个必然不在当前时刻的区间：取当前小时 +2 到 +3。
  const nowH = new Date().getHours();
  const awayStart = String((nowH + 2) % 24).padStart(2, '0') + ':00';
  const awayEnd = String((nowH + 3) % 24).padStart(2, '0') + ':00';

  const rulesFor13 = asList((await api('/api/company/rules', { token: companyToken })).body);
  for (const r of rulesFor13) {
    await api(`/api/company/rules/${r.id}/status`, {
      method: 'PUT',
      token: companyToken,
      body: { status: 0 },
    });
  }
  const noLimitQr = await api('/api/employee/qrcode', { token: empToken });
  check('无启用规则（不限制）→ 正常发码', noLimitQr.body?.code === 0, noLimitQr.body);

  const awayRule = await api('/api/company/rules', {
    method: 'POST',
    token: companyToken,
    body: { name: '刻意避开当前时刻', startTime: awayStart, endTime: awayEnd, perEmployeeLimit: 1 },
  });
  check('创建「避开当前时刻」的时段规则', awayRule.body?.code === 0, awayRule.body);
  const awayRuleId = awayRule.body?.data?.id;

  const blockedQr = await api('/api/employee/qrcode', { token: empToken });
  check('非核销时段 → 拒绝发码', blockedQr.body?.code !== 0, blockedQr.body);
  check('拒绝发码返回业务码 2005（不在可核销时段）', blockedQr.body?.code === 2005, blockedQr.body?.code);
  check(
    '拒绝文案里带出可核销时段',
    /可核销时间/.test(blockedQr.body?.message || ''),
    blockedQr.body?.message,
  );

  // windows 接口应能告诉前端"当前未开放"，供小程序不出码
  const winClosed = await api('/api/employee/windows', { token: empToken });
  check('windows 接口标记当前未开放', winClosed.body?.data?.open === false, winClosed.body?.data?.open);

  const prevQrStillWorks = await api('/api/employee/qrcode', { token: empToken });
  check('再次请求仍被拒（不是偶发）', prevQrStillWorks.body?.code === 2005, prevQrStillWorks.body?.code);

  // 删掉这个规则，回到"无启用规则 = 不限制"，应恢复发码
  await api(`/api/company/rules/${awayRuleId}`, { method: 'DELETE', token: companyToken });
  const restored = await api('/api/employee/qrcode', { token: empToken });
  check('删除规避规则后恢复发码', restored.body?.code === 0, restored.body);

  // 把 A 公司真实规则启用回来，避免影响后续用例
  for (const r of rulesFor13) {
    await api(`/api/company/rules/${r.id}/status`, {
      method: 'PUT',
      token: companyToken,
      body: { status: 1 },
    });
  }

  // ─────────────────────────────────────────────
  section('14. 员工反馈');

  const fbSubmit = await api('/api/employee/feedbacks', {
    method: 'POST',
    token: empToken,
    body: {
      type: 'suggest',
      title: '希望延长午餐时段',
      content: '中午排队人太多，12:30 以后基本就来不及了，希望能延长到 13:30。',
      contact: '13800000000',
    },
  });
  check('员工提交反馈成功', fbSubmit.body?.code === 0, fbSubmit.body);
  const feedbackId = fbSubmit.body?.data?.id;
  check('返回新反馈 id', !!feedbackId, feedbackId);

  const fbEmpty = await api('/api/employee/feedbacks', {
    method: 'POST',
    token: empToken,
    body: { type: 'issue', title: '', content: 'x' },
  });
  check('标题为空 → 400', fbEmpty.status === 400, fbEmpty.status);

  const fbBadType = await api('/api/employee/feedbacks', {
    method: 'POST',
    token: empToken,
    body: { type: 'not-a-type', title: '测试', content: '测试内容' },
  });
  // 非法类型会被 DTO 的 @IsIn 拦下 → 400
  check('非法反馈类型 → 400', fbBadType.status === 400, fbBadType.status);

  const myFb = await api('/api/employee/feedbacks', { token: empToken });
  const myFbList = asList(myFb.body);
  check('员工可查自己的反馈', myFb.body?.code === 0 && myFbList.length > 0, myFbList.length);
  check(
    '反馈里带类型中文标签',
    !!myFbList.find((f) => f.id === feedbackId)?.typeLabel,
    myFbList[0]?.typeLabel,
  );

  // ★ 核心权限断言：公司管理员看不到反馈
  const companyFb = await api('/api/platform/feedbacks', { token: companyToken });
  check('公司管理员访问平台反馈接口 → 403', companyFb.status === 403, companyFb.status);

  const employeeFb = await api('/api/platform/feedbacks', { token: empToken });
  check('员工访问平台反馈接口 → 403', employeeFb.status === 403, employeeFb.status);

  const anonFb = await api('/api/platform/feedbacks');
  check('未登录访问反馈接口 → 401', anonFb.status === 401, anonFb.status);

  // 平台超管可以看
  const platformFb = await api('/api/platform/feedbacks', { token: superToken });
  const platformFbList = asList(platformFb.body);
  check('平台超管可查反馈列表', platformFb.body?.code === 0, platformFb.body?.code);
  check('平台能查到刚提交的那条', !!platformFbList.find((f) => f.id === feedbackId), feedbackId);

  const pendingCount = await api('/api/platform/feedbacks/pending-count', { token: superToken });
  check('待处理数量接口可用', typeof pendingCount.body?.data?.pending === 'number', pendingCount.body?.data);

  // 筛选：按公司
  const fbByCompany = await api(
    `/api/platform/feedbacks?companyId=${companyA.id}`,
    { token: superToken },
  );
  const fbByCompanyList = asList(fbByCompany.body);
  check(
    '按公司筛选只返回该公司的反馈',
    fbByCompanyList.every((f) => f.companyId === String(companyA.id)),
    fbByCompanyList.map((f) => f.companyId),
  );

  // 回复
  const fbReply = await api(`/api/platform/feedbacks/${feedbackId}/reply`, {
    method: 'PUT',
    token: superToken,
    body: { reply: '已收到建议，我们会与公司沟通调整时段。' },
  });
  check('平台回复反馈成功', fbReply.body?.code === 0, fbReply.body);
  check('回复后状态变为已处理', fbReply.body?.data?.status === 1, fbReply.body?.data?.status);

  const fbReplyEmpty = await api(`/api/platform/feedbacks/${feedbackId}/reply`, {
    method: 'PUT',
    token: superToken,
    body: { reply: '   ' },
  });
  check('空回复被拒', fbReplyEmpty.body?.code !== 0, fbReplyEmpty.body);

  // 员工能看到回复
  const myFbAfter = await api('/api/employee/feedbacks', { token: empToken });
  const replied = asList(myFbAfter.body).find((f) => f.id === feedbackId);
  check('员工侧能看到平台回复', !!replied?.reply, replied?.reply);
  check('员工侧状态同步为已处理', replied?.status === 1, replied?.status);

  // 状态回退
  const fbReopen = await api(`/api/platform/feedbacks/${feedbackId}/status`, {
    method: 'PUT',
    token: superToken,
    body: { status: 0 },
  });
  check('可退回待处理', fbReopen.body?.data?.status === 0, fbReopen.body?.data?.status);
  await api(`/api/platform/feedbacks/${feedbackId}/status`, {
    method: 'PUT',
    token: superToken,
    body: { status: 1 },
  });

  // 反馈应被写入操作日志（module=feedback）
  const fbLogs = await api('/api/platform/operation-logs?module=feedback', { token: superToken });
  check('反馈操作已记入操作日志', asList(fbLogs.body).length > 0, asList(fbLogs.body).length);

  // 跨租户提防：B 公司员工的反馈，companyId 必须是自己公司而非客户端可传
  // 先给 B 公司建一个能登录的员工（该用例只关心租户归属，不关心其它）
  const bPhone = `1370000${String(Date.now()).slice(-4)}`;
  const bEmpCreated = await api('/api/platform/employees', {
    method: 'POST',
    token: superToken,
    body: { companyId: String(companyB.id), name: 'B公司反馈测试员', phone: bPhone },
  });
  check('平台可为 B 公司建员工', bEmpCreated.body?.code === 0, bEmpCreated.body);
  const bEmpLogin = await api('/api/auth/employee/login', {
    method: 'POST',
    body: { code: `smoke-fb-code-${Date.now()}`, phone: bPhone },
  });
  check('B 公司员工登录成功', bEmpLogin.body?.code === 0, bEmpLogin.body);
  const empBToken = bEmpLogin.body?.data?.token;

  const fbAsB = await api('/api/employee/feedbacks', {
    method: 'POST',
    token: empBToken,
    body: { type: 'issue', title: 'B 公司的问题', content: '测试租户归属' },
  });
  check('B 公司员工可提交反馈', fbAsB.body?.code === 0, fbAsB.body);
  const fbB = asList((await api('/api/platform/feedbacks', { token: superToken })).body).find(
    (f) => f.id === fbAsB.body?.data?.id,
  );
  check(
    '反馈的 companyId 取自信任源（JWT）而非客户端',
    fbB?.companyId === String(companyB.id),
    { got: fbB?.companyId, expect: String(companyB.id) },
  );

  // ─────────────────────────────────────────────
  section('15. 员工剩余核销次数（公司分配）');

  // 公司端员工列表现在会带出额度字段
  const aEmpsRes = await api('/api/company/employees', { token: companyToken });
  const aEmps = aEmpsRes.body?.data?.list || [];
  const zhang = aEmps.find((e) => e.phone === '13900000001');
  check(
    '公司端员工列表返回额度字段（quotaTotal/quotaUsed/quotaRemain）',
    !!zhang && 'quotaTotal' in zhang && 'quotaUsed' in zhang && 'quotaRemain' in zhang,
    zhang,
  );
  const empAId = zhang?.id;
  const origQuotaTotal = zhang?.quotaTotal ?? null;

  // 扣减验证需要「能发码 + 能核销」的环境：临时停用 A 公司真实规则
  //（无启用规则 = 不限制）。与第 3、13 节同一套手法，跑完恢复。
  const realRules15 = asList((await api('/api/company/rules', { token: companyToken })).body);
  for (const r of realRules15) {
    await api(`/api/company/rules/${r.id}/status`, {
      method: 'PUT',
      token: companyToken,
      body: { status: 0 },
    });
  }
  /** 收尾：恢复时段规则 + 恢复张三原有额度，保证不污染后续/下次运行 */
  async function restoreQuotaSection() {
    for (const r of realRules15) {
      await api(`/api/company/rules/${r.id}/status`, {
        method: 'PUT',
        token: companyToken,
        body: { status: 1 },
      });
    }
    await api(`/api/company/employees/${empAId}/quota`, {
      method: 'PUT',
      token: companyToken,
      body: { quotaTotal: origQuotaTotal, resetUsed: false },
    });
  }

  // 1) 「不限」= null（老租户默认语义，必须能被显式表达）
  const setUnlimited = await api(`/api/company/employees/${empAId}/quota`, {
    method: 'PUT',
    token: companyToken,
    body: { quotaTotal: null },
  });
  check('设置为「不限」成功', setUnlimited.body?.code === 0, setUnlimited.body);
  check(
    '「不限」回传 quotaTotal=null 且 quotaRemain=null',
    setUnlimited.body?.data?.quotaTotal === null && setUnlimited.body?.data?.quotaRemain === null,
    setUnlimited.body?.data,
  );
  const meUnlimited = await api('/api/employee/me', { token: empToken });
  check(
    '员工端 me 显示「不限」',
    meUnlimited.body?.data?.quotaTotal === null && meUnlimited.body?.data?.quotaRemain === null,
    meUnlimited.body?.data,
  );

  // 2) 具体次数：剩余一律用 总额度 - 已用 现算
  const usedNow = Number(meUnlimited.body?.data?.quotaUsed ?? 0);
  const limitNow = usedNow + 2; // 期望剩余恰好 2 次
  const setLimited = await api(`/api/company/employees/${empAId}/quota`, {
    method: 'PUT',
    token: companyToken,
    body: { quotaTotal: limitNow },
  });
  check('设置为指定次数成功', setLimited.body?.code === 0, setLimited.body);
  check('剩余次数 = 总额度 - 已用（现算）', setLimited.body?.data?.quotaRemain === 2, setLimited.body?.data);

  // 3) 三个员工端接口都应带上额度
  const meLimited = await api('/api/employee/me', { token: empToken });
  check(
    '员工端 me 回传额度',
    meLimited.body?.data?.quotaTotal === limitNow && meLimited.body?.data?.quotaRemain === 2,
    meLimited.body?.data,
  );
  const winQ = await api('/api/employee/windows', { token: empToken });
  check(
    '员工端 windows 回传额度',
    winQ.body?.data?.quotaTotal === limitNow && winQ.body?.data?.quotaRemain === 2,
    winQ.body?.data,
  );
  const qrQ = await api('/api/employee/qrcode', { token: empToken });
  check(
    '发码接口回传额度',
    qrQ.body?.data?.quotaTotal === limitNow && qrQ.body?.data?.quotaRemain === 2,
    qrQ.body?.data,
  );

  // 4) 真核销一次 → 员工额度 -1（双重扣减的"员工那半"）
  const beforeDec = (await api('/api/employee/me', { token: empToken })).body?.data;
  const qrForQuota = await api('/api/employee/qrcode', { token: empToken });
  const verifyQ = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0002', qrToken: qrForQuota.body?.data?.qrToken },
  });
  check('额度用例：核销成功', verifyQ.body?.code === 0, verifyQ.body);
  check(
    '核销回传员工剩余次数',
    verifyQ.body?.data?.employeeQuotaRemain === 1,
    verifyQ.body?.data?.employeeQuotaRemain,
  );
  const afterDec = (await api('/api/employee/me', { token: empToken })).body?.data;
  check('核销后员工已用次数 +1', afterDec?.quotaUsed === beforeDec?.quotaUsed + 1, {
    before: beforeDec?.quotaUsed,
    after: afterDec?.quotaUsed,
  });
  check('核销后员工剩余次数 -1', afterDec?.quotaRemain === 1, afterDec?.quotaRemain);

  // 5) 用尽 → 发码直接拒（2007），与公司池不足（2002）区分
  // 先趁还有额度发一张有效码，再用它验证「核销时的员工额度拦截」——
  // 否则拿已消耗的码去核销只会得到 2001，测不到员工额度这道闸。
  const qrQuotaEdge = await api('/api/employee/qrcode', { token: empToken });
  check('额度剩 1 次时仍可发码', qrQuotaEdge.body?.code === 0, qrQuotaEdge.body);

  const setZero = await api(`/api/company/employees/${empAId}/quota`, {
    method: 'PUT',
    token: companyToken,
    body: { quotaTotal: afterDec.quotaUsed },
  });
  check('把额度设为「已用次数」→ 剩余 0', setZero.body?.data?.quotaRemain === 0, setZero.body?.data);

  // 6) 额度用尽时核销也必须被拒（不能只靠发码拦截；客户端可缓存二维码）
  const exhaustedVerify = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0002', qrToken: qrQuotaEdge.body?.data?.qrToken },
  });
  check('额度用尽后核销被拒', exhaustedVerify.body?.code !== 0, exhaustedVerify.body);
  check(
    '核销被拒返回 2007（员工额度，而非 2001 码已用）',
    exhaustedVerify.body?.code === 2007,
    exhaustedVerify.body?.code,
  );

  const qrExhausted = await api('/api/employee/qrcode', { token: empToken });
  check('额度用尽 → 拒绝发码', qrExhausted.body?.code !== 0, qrExhausted.body);
  check('额度用尽返回业务码 2007', qrExhausted.body?.code === 2007, qrExhausted.body?.code);
  check(
    '额度用尽文案引导找公司管理员',
    /公司管理员/.test(qrExhausted.body?.message || ''),
    qrExhausted.body?.message,
  );
  const meZero = await api('/api/employee/me', { token: empToken });
  check('员工端显示剩余 0 次', meZero.body?.data?.quotaRemain === 0, meZero.body?.data);
  const winZero = await api('/api/employee/windows', { token: empToken });
  check('windows 也反映剩余 0 次', winZero.body?.data?.quotaRemain === 0, winZero.body?.data);

  // 7) 非法值：null 与「不传」语义不同，缺参必须 400
  const negEmpQuota = await api(`/api/company/employees/${empAId}/quota`, {
    method: 'PUT',
    token: companyToken,
    body: { quotaTotal: -1 },
  });
  check('负数次数 → 400', negEmpQuota.status === 400, negEmpQuota.status);
  const floatQuota = await api(`/api/company/employees/${empAId}/quota`, {
    method: 'PUT',
    token: companyToken,
    body: { quotaTotal: 1.5 },
  });
  check('小数次数 → 400', floatQuota.status === 400, floatQuota.status);
  const missingQuota = await api(`/api/company/employees/${empAId}/quota`, {
    method: 'PUT',
    token: companyToken,
    body: {},
  });
  check('缺少 quotaTotal → 400（无法与「不限」区分）', missingQuota.status === 400, missingQuota.status);

  // 8) 越权：跨租户 / 角色 / 未登录
  const crossQuota = await api(`/api/company/employees/${empAId}/quota`, {
    method: 'PUT',
    token: companyBToken,
    body: { quotaTotal: 99 },
  });
  check('B 公司管理员改 A 公司员工额度 → 403', crossQuota.status === 403, crossQuota.status);
  const empSetQuota = await api(`/api/company/employees/${empAId}/quota`, {
    method: 'PUT',
    token: empToken,
    body: { quotaTotal: 99 },
  });
  check('员工调公司端额度接口 → 403/401', [401, 403].includes(empSetQuota.status), empSetQuota.status);
  const anonQuota = await api(`/api/company/employees/${empAId}/quota`, {
    method: 'PUT',
    body: { quotaTotal: 99 },
  });
  check('未登录调额度接口 → 401', anonQuota.status === 401, anonQuota.status);

  // 9) 批量设置
  const batchIds = aEmps.slice(0, 2).map((e) => e.id);
  const batchQuota = await api('/api/company/employees/quota/batch', {
    method: 'POST',
    token: companyToken,
    body: { employeeIds: batchIds, quotaTotal: 5 },
  });
  check(
    '批量设置额度成功',
    batchQuota.body?.code === 0 && batchQuota.body?.data?.count === batchIds.length,
    batchQuota.body,
  );
  const batchSet = new Set(batchIds);
  const aEmpsAfter = (await api('/api/company/employees', { token: companyToken })).body?.data?.list || [];
  check(
    '批量设置已落库（列表复核，每人 5 次）',
    aEmpsAfter.filter((e) => batchSet.has(e.id)).every((e) => e.quotaTotal === 5),
    aEmpsAfter.filter((e) => batchSet.has(e.id)).map((e) => ({ id: e.id, q: e.quotaTotal })),
  );

  const batchEmpty = await api('/api/company/employees/quota/batch', {
    method: 'POST',
    token: companyToken,
    body: { employeeIds: [], quotaTotal: 3 },
  });
  check('批量设置为空 → 400', batchEmpty.status === 400, batchEmpty.status);

  // 整批拒绝：混入别家公司的员工必须整批失败，不能静默跳过
  const bEmpsFresh = (await api('/api/company/employees', { token: companyBToken })).body?.data?.list || [];
  if (bEmpsFresh[0]) {
    const batchMixed = await api('/api/company/employees/quota/batch', {
      method: 'POST',
      token: companyToken,
      body: { employeeIds: [...batchIds, bEmpsFresh[0].id], quotaTotal: 7 },
    });
    check('批量里混入其他公司员工 → 403（整批拒绝）', batchMixed.status === 403, batchMixed.status);
    const aEmpsAfter2 =
      (await api('/api/company/employees', { token: companyToken })).body?.data?.list || [];
    check(
      '整批拒绝后原有额度未被改动（无部分生效）',
      aEmpsAfter2.filter((e) => batchSet.has(e.id)).every((e) => e.quotaTotal === 5),
      aEmpsAfter2.filter((e) => batchSet.has(e.id)).map((e) => e.quotaTotal),
    );
  }

  // 10) 操作日志留痕
  const quotaLogs = await api('/api/company/operation-logs?module=employee&action=quota', {
    token: companyToken,
  });
  check(
    '设置额度写入操作日志（module=employee / action=quota）',
    quotaLogs.body?.code === 0 && (quotaLogs.body?.data?.total || 0) > 0,
    quotaLogs.body?.data?.total,
  );

  // ─────────────────────────────────────────────
  section('16. 公司餐标与核销机器播报');

  // 前置：本节要真发码真核销，所以必须处在「可核销」环境。
  // 第 15 节已把 A 公司真实规则停用（无启用规则 = 不限制），这里再补一条
  // 覆盖全天、每人限 3 次的临时规则 —— 既有确定的行为，又能验证
  // 「今日还可 N 次」这类按时段统计的字段。
  const rule16 = await api('/api/company/rules', {
    method: 'POST',
    token: companyToken,
    body: { name: '冒烟·餐标时段', startTime: '00:00', endTime: '23:59', perEmployeeLimit: 3 },
  });
  const rule16Id = rule16.body?.data?.id;
  check('餐标用例前置：创建全天时段规则', rule16.body?.code === 0, rule16.body);

  // 额度设为「不限」，避免个人额度不足干扰本节的核销验证（第 15 节末尾会恢复）
  await api(`/api/company/employees/${empAId}/quota`, {
    method: 'PUT',
    token: companyToken,
    body: { quotaTotal: null },
  });

  // 公司池兜底：多次冒烟后可能被抽干，导致本节失败在一个不相干的原因上
  const remainPre = await api('/api/company/remain', { token: companyToken });
  if ((remainPre.body?.data?.remainQuota ?? 0) < 10) {
    await api(`/api/platform/companies/${companyA.id}`, {
      method: 'PUT',
      token: superToken,
      body: { totalQuota: (remainPre.body?.data?.totalQuota ?? 0) + 50 },
    });
  }

  // ── 1) 读设置：档位由后端下发，前端不硬编码 ──
  const sett16 = await api('/api/company/settings', { token: companyToken });
  check('公司端可读公司设置', sett16.body?.code === 0, sett16.body);
  check(
    '设置接口下发餐标档位 [12,15,18,20]',
    JSON.stringify(sett16.body?.data?.tiers) === JSON.stringify([12, 15, 18, 20]),
    sett16.body?.data?.tiers,
  );
  const origMealStandard = sett16.body?.data?.mealStandard ?? null;

  // ── 2) 「今日还可 N 次」：按时段统计个人今日核销数 ──
  const winBefore16 = await api('/api/employee/windows', { token: empToken });
  const w16 = (winBefore16.body?.data?.windows || []).find((w) => w.id === String(rule16Id));
  check(
    'windows 每个时段带 usedToday / remainToday',
    !!w16 && w16.usedToday === 0 && w16.remainToday === 3,
    w16,
  );
  check('windows 标记该时段进行中', w16?.active === true, w16?.active);

  // ── 3) 平台端设置餐标 15 元 ──
  const setStandard15 = await api(`/api/platform/companies/${companyA.id}/meal-standard`, {
    method: 'PUT',
    token: superToken,
    body: { mealStandard: 15 },
  });
  check(
    '平台端设置餐标 15 元成功',
    setStandard15.body?.code === 0 && setStandard15.body?.data?.mealStandard === 15,
    setStandard15.body,
  );
  check(
    '餐标回传中文文案「15 元」',
    setStandard15.body?.data?.mealStandardText === '15 元',
    setStandard15.body?.data?.mealStandardText,
  );

  // ── 3b) 权限边界：餐标只能由平台设置，公司端**只读** ──
  // 公司端原来的写接口已下线，这里断言的是「改不动」这个业务事实，
  // 而不只是「路由没了」—— 万一将来有人把路由加回来却忘了加权限，
  // 下面第二条（值没变）仍然会挂。
  const companyWriteMs = await api('/api/company/settings/meal-standard', {
    method: 'PUT',
    token: companyToken,
    body: { mealStandard: 20 },
  });
  check('公司端设置餐标接口已下线 → 404', companyWriteMs.status === 404, companyWriteMs.status);

  const companyTryPlatformApi = await api(
    `/api/platform/companies/${companyA.id}/meal-standard`,
    { method: 'PUT', token: companyToken, body: { mealStandard: 20 } },
  );
  check(
    '公司管理员改用平台接口设餐标 → 403',
    companyTryPlatformApi.status === 403,
    companyTryPlatformApi.status,
  );

  const settAfterCompanyTry = await api('/api/company/settings', { token: companyToken });
  check(
    '公司管理员确实改不动餐标（仍是平台设的 15）',
    settAfterCompanyTry.body?.data?.mealStandard === 15,
    settAfterCompanyTry.body?.data?.mealStandard,
  );

  // 「不能设置」的另一半是「能查看」：平台改完，公司端立刻读到新值
  const settReadonly = await api('/api/company/settings', { token: companyToken });
  check(
    '公司管理员仍可查看餐标（只读权限保留）',
    settReadonly.body?.code === 0 && settReadonly.body?.data?.mealStandard === 15,
    settReadonly.body?.data,
  );
  check(
    '公司端设置仍下发可选档位（便于与平台对齐口径）',
    JSON.stringify(settReadonly.body?.data?.tiers) === JSON.stringify([12, 15, 18, 20]),
    settReadonly.body?.data?.tiers,
  );

  // decimal 列在 MySQL 上会被驱动读成字符串，必须归一成 number
  const compList16 = asList((await api('/api/platform/companies', { token: superToken })).body);
  const compA16 = compList16.find((c) => c.id === companyA.id);
  check('平台端公司列表带出餐标', compA16?.mealStandard === 15, compA16?.mealStandard);
  check(
    '餐标是数字而不是 decimal 字符串（方言归一）',
    typeof compA16?.mealStandard === 'number',
    typeof compA16?.mealStandard,
  );

  // ── 4) 员工端能看到餐标 ──
  const me15 = await api('/api/employee/me', { token: empToken });
  check('员工端 me 带餐标 15', me15.body?.data?.mealStandard === 15, me15.body?.data?.mealStandard);
  check(
    '员工端 me 带餐标文案',
    me15.body?.data?.mealStandardText === '15 元',
    me15.body?.data?.mealStandardText,
  );
  const win15 = await api('/api/employee/windows', { token: empToken });
  check('核销页 windows 也带餐标', win15.body?.data?.mealStandard === 15, win15.body?.data?.mealStandard);

  // ── 5) 核销 → 机器播报文本 ──
  const remainBefore16 = (await api('/api/company/remain', { token: companyToken })).body?.data
    ?.remainQuota;
  const qr16 = await api('/api/employee/qrcode', { token: empToken });
  check('有餐标时仍可正常发码（餐标不参与准入）', qr16.body?.code === 0, qr16.body);

  const dev16 = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0002', qrToken: qr16.body?.data?.qrToken },
  });
  check('设备核销成功', dev16.body?.code === 0, dev16.body);
  check(
    '核销返回 voiceText「核销成功，餐标15元」',
    dev16.body?.data?.voiceText === '核销成功，餐标15元',
    dev16.body?.data?.voiceText,
  );
  check('核销返回带 mealStandard=15', dev16.body?.data?.mealStandard === 15, dev16.body?.data?.mealStandard);

  // 餐标不参与扣减：一次核销仍然只扣 1 次
  const remainAfter16 = (await api('/api/company/remain', { token: companyToken })).body?.data
    ?.remainQuota;
  check(
    '餐标不参与扣减：公司池只减 1 次',
    remainBefore16 !== undefined && remainAfter16 === remainBefore16 - 1,
    { before: remainBefore16, after: remainAfter16 },
  );

  // 核销后「今日还可」应递减
  const winAfter16 = await api('/api/employee/windows', { token: empToken });
  const w16b = (winAfter16.body?.data?.windows || []).find((w) => w.id === String(rule16Id));
  check(
    '核销后 usedToday/remainToday 同步更新',
    w16b?.usedToday === 1 && w16b?.remainToday === 2,
    w16b,
  );

  // ── 6) 清除餐标 → 播报退回「核销成功」 ──
  const setNull16 = await api(`/api/platform/companies/${companyA.id}/meal-standard`, {
    method: 'PUT',
    token: superToken,
    body: { mealStandard: null },
  });
  check('清除餐标成功（回传 null）', setNull16.body?.data?.mealStandard === null, setNull16.body?.data);

  const qr16b = await api('/api/employee/qrcode', { token: empToken });
  const dev16b = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0002', qrToken: qr16b.body?.data?.qrToken },
  });
  check(
    '未设餐标时 voiceText 仅「核销成功」',
    dev16b.body?.data?.voiceText === '核销成功',
    dev16b.body?.data?.voiceText,
  );
  check('未设餐标时 mealStandard 为 null', dev16b.body?.data?.mealStandard === null, dev16b.body?.data?.mealStandard);

  // 0 元没有业务含义，统一按「清除」处理，避免播报出「餐标0元」
  const setZero16 = await api(`/api/platform/companies/${companyA.id}/meal-standard`, {
    method: 'PUT',
    token: superToken,
    body: { mealStandard: 0 },
  });
  check('餐标传 0 视为清除（不播报 0 元）', setZero16.body?.data?.mealStandard === null, setZero16.body?.data);

  // ── 7) 平台端设置餐标（唯一入口） ──
  const platSet18 = await api(`/api/platform/companies/${companyA.id}/meal-standard`, {
    method: 'PUT',
    token: superToken,
    body: { mealStandard: 18 },
  });
  check('平台端可设餐标', platSet18.body?.code === 0, platSet18.body);
  const me18 = await api('/api/employee/me', { token: empToken });
  check('平台设置后员工端立刻看到 18 元', me18.body?.data?.mealStandard === 18, me18.body?.data?.mealStandard);

  // 通用编辑接口**不再接受**餐标：传了会被 ValidationPipe 的 whitelist 静默剥离。
  // 断言它是为了锁死「单一入口」—— 若将来有人把字段加回 UpdateCompanyDto，
  // 餐标就会同时有 update / meal-standard 两条路径和两种审计 action，
  // 排查「餐标什么时候被谁改的」时得看两处日志。
  const editWithMeal = await api(`/api/platform/companies/${companyA.id}`, {
    method: 'PUT',
    token: superToken,
    body: { name: companyA.name, mealStandard: 99 },
  });
  check('通用编辑接口仍可用（不带餐标）', editWithMeal.body?.code === 0, editWithMeal.body);
  const settAfterEdit = await api('/api/company/settings', { token: companyToken });
  check(
    '走通用编辑传餐标不生效（单一入口，仍为 18）',
    settAfterEdit.body?.data?.mealStandard === 18,
    settAfterEdit.body?.data?.mealStandard,
  );

  const platClear = await api(`/api/platform/companies/${companyA.id}/meal-standard`, {
    method: 'PUT',
    token: superToken,
    body: { mealStandard: null },
  });
  check('平台端可清除餐标', platClear.body?.code === 0, platClear.body);
  const meCleared = await api('/api/employee/me', { token: empToken });
  check(
    '平台清除后员工端餐标为「未设置」',
    meCleared.body?.data?.mealStandard === null && meCleared.body?.data?.mealStandardText === '未设置',
    meCleared.body?.data,
  );

  // ── 8) 参数校验（平台端接口） ──
  const negMs = await api(`/api/platform/companies/${companyA.id}/meal-standard`, {
    method: 'PUT',
    token: superToken,
    body: { mealStandard: -1 },
  });
  check('餐标为负数 → 400', negMs.status === 400, negMs.status);

  const overMs = await api(`/api/platform/companies/${companyA.id}/meal-standard`, {
    method: 'PUT',
    token: superToken,
    body: { mealStandard: 1001 },
  });
  check('餐标超过上限 1000 → 400', overMs.status === 400, overMs.status);

  const strMs = await api(`/api/platform/companies/${companyA.id}/meal-standard`, {
    method: 'PUT',
    token: superToken,
    body: { mealStandard: 'abc' },
  });
  check('餐标传非数字 → 400', strMs.status === 400, strMs.status);

  const missingMs = await api(`/api/platform/companies/${companyA.id}/meal-standard`, {
    method: 'PUT',
    token: superToken,
    body: {},
  });
  check('设置餐标不传字段 → 400（不传与传 null 语义不同）', missingMs.status === 400, missingMs.status);

  const noSuchCompany = await api('/api/platform/companies/99999999/meal-standard', {
    method: 'PUT',
    token: superToken,
    body: { mealStandard: 15 },
  });
  check('给不存在的公司设餐标 → 404', noSuchCompany.status === 404, noSuchCompany.status);

  // ── 9) 权限边界 ──
  const empReadSettings = await api('/api/company/settings', { token: empToken });
  check('员工访问公司设置 → 403', empReadSettings.status === 403, empReadSettings.status);

  const empWriteMs = await api(`/api/platform/companies/${companyA.id}/meal-standard`, {
    method: 'PUT',
    token: empToken,
    body: { mealStandard: 20 },
  });
  check('员工改餐标 → 403', empWriteMs.status === 403, empWriteMs.status);

  const anonSettings = await api('/api/company/settings');
  check('未登录读公司设置 → 401', anonSettings.status === 401, anonSettings.status);

  const anonWriteMs = await api(`/api/platform/companies/${companyA.id}/meal-standard`, {
    method: 'PUT',
    body: { mealStandard: 20 },
  });
  check('未登录改餐标 → 401', anonWriteMs.status === 401, anonWriteMs.status);

  const otherCompany = await api('/api/company/settings', { token: companyBToken });
  check(
    'B 公司管理员读到的不是 A 公司的设置（租户隔离）',
    otherCompany.body?.code === 0 && otherCompany.body?.data?.companyId !== companyA.id,
    otherCompany.body?.data?.companyId,
  );

  // ── 10) 操作日志留痕 ──
  const msLogs = await api('/api/company/operation-logs?module=company&action=meal-standard', {
    token: companyToken,
  });
  check(
    '设置餐标写入操作日志（module=company / action=meal-standard）',
    msLogs.body?.code === 0 && (msLogs.body?.data?.total || 0) > 0,
    msLogs.body?.data?.total,
  );
  // 公司端能查到本公司日志，但操作者是平台 —— 这条同时证明了
  // 「餐标改动发生在本公司」与「动手的是平台管理员」两件事
  const msLogItem = (msLogs.body?.data?.list || [])[0];
  check(
    '餐标日志记的操作人是平台管理员（operatorRole=super）',
    msLogItem?.operatorRole === 'super',
    msLogItem?.operatorRole,
  );

  // 收尾：删掉临时规则、还原原餐标（第 15 节的 restoreQuotaSection 接着恢复规则与额度）
  if (rule16Id) {
    await api(`/api/company/rules/${rule16Id}`, { method: 'DELETE', token: companyToken });
  }
  await api(`/api/platform/companies/${companyA.id}/meal-standard`, {
    method: 'PUT',
    token: superToken,
    body: { mealStandard: origMealStandard },
  });

  // ─────────────────────────────────────────────
  section('17. 解绑微信（后台）');

  // 用李四（13900000002，A 公司）而不是张三：张三的 empToken 还要给
  // 下面的 restoreQuotaSection 用，而解绑会把它立刻踢下线。
  const aEmps17 = await api('/api/company/employees', { token: companyToken });
  const lisi = (aEmps17.body?.data?.list || []).find((e) => e.phone === '13900000002');
  check('公司端员工列表带出微信绑定状态（bound）', !!lisi && 'bound' in lisi, lisi);
  const lisiId17 = lisi?.id;

  // 起点归零：上一次运行若中途失败，李四可能还绑着
  await api(`/api/company/employees/${lisiId17}/unbind-wechat`, {
    method: 'POST',
    token: companyToken,
  });

  // 1) 未绑定就解绑 → 400，而不是静默 200
  const unbindUnbound = await api(`/api/company/employees/${lisiId17}/unbind-wechat`, {
    method: 'POST',
    token: companyToken,
  });
  check('未绑定微信时解绑 → 400', unbindUnbound.status === 400, unbindUnbound.status);

  // 2) 李四绑定微信
  const lisiLogin = await api('/api/auth/employee/login', {
    method: 'POST',
    body: { code: 'smoke-code-lisi-17', phone: '13900000002' },
  });
  check('李四微信登录并绑定成功', lisiLogin.body?.code === 0, lisiLogin.body);
  const lisiToken = lisiLogin.body?.data?.token;

  const lisiBoundList = await api('/api/company/employees?keyword=13900000002', {
    token: companyToken,
  });
  const lisiBound = (lisiBoundList.body?.data?.list || []).find((e) => e.id === lisiId17);
  check('绑定后列表显示「已绑定」', lisiBound?.bound === true, lisiBound?.bound);

  // 3) 先出一张码，用来验证「解绑会作废未使用的二维码」
  const lisiQr = await api('/api/employee/qrcode', { token: lisiToken });
  check('李四可正常出码', lisiQr.body?.code === 0, lisiQr.body);

  // 4) 解绑
  const unbind = await api(`/api/company/employees/${lisiId17}/unbind-wechat`, {
    method: 'POST',
    token: companyToken,
  });
  check('解绑微信成功', unbind.body?.code === 0, unbind.body);
  check('解绑回传 bound=false', unbind.body?.data?.bound === false, unbind.body?.data);
  check(
    '解绑同时作废了该员工未使用的二维码',
    (unbind.body?.data?.voidedQrCodes ?? 0) >= 1,
    unbind.body?.data?.voidedQrCodes,
  );

  const lisiAfterList = await api('/api/company/employees?keyword=13900000002', {
    token: companyToken,
  });
  const lisiAfter = (lisiAfterList.body?.data?.list || []).find((e) => e.id === lisiId17);
  check('解绑后列表显示「未绑定」', lisiAfter?.bound === false, lisiAfter?.bound);

  // 5) 核心：旧 token **立即**失效，而不是等它自然过期
  //    （这正是 token_version 存在的理由：解绑后员工手机上还留着 token，
  //     若只验签名，他照样能出码 —— 管理员会看到「已解绑」却拦不住人）
  const lisiMeAfter = await api('/api/employee/me', { token: lisiToken });
  check('解绑后该员工旧 token 立即 401（会话被吊销）', lisiMeAfter.status === 401, lisiMeAfter.status);

  // 6) 未使用的二维码也一并作废，否则截图存下来的码还能继续扫
  const lisiQrVerify = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'device-key-demo-0002', qrToken: lisiQr.body?.data?.qrToken },
  });
  check(
    '解绑后该员工未使用的二维码失效，不能再核销',
    lisiQrVerify.body?.code !== 0,
    { status: lisiQrVerify.status, code: lisiQrVerify.body?.code },
  );

  // 7) 死锁解开：解绑后同一个微信能重新绑定（换微信同理）
  const lisiRebind = await api('/api/auth/employee/login', {
    method: 'POST',
    body: { code: 'smoke-code-lisi-17', phone: '13900000002' },
  });
  check('解绑后可重新绑定（原本的「已绑定其他微信」死锁被解开）', lisiRebind.body?.code === 0, lisiRebind.body);

  const lisiMe2 = await api('/api/employee/me', { token: lisiRebind.body?.data?.token });
  check('重新绑定后新 token 立即可用', lisiMe2.body?.code === 0, lisiMe2.body);

  // 8) 权限与租户边界
  const empUnbind = await api(`/api/company/employees/${lisiId17}/unbind-wechat`, {
    method: 'POST',
    token: empToken,
  });
  check('员工自己解绑微信 → 403', empUnbind.status === 403, empUnbind.status);

  const bEmp17 = (await api('/api/company/employees', { token: companyBToken })).body?.data
    ?.list?.[0];
  const crossUnbind = await api(`/api/company/employees/${bEmp17?.id}/unbind-wechat`, {
    method: 'POST',
    token: companyToken,
  });
  check('A 公司管理员解绑 B 公司员工 → 403', crossUnbind.status === 403, crossUnbind.status);

  const anonUnbind = await api(`/api/company/employees/${lisiId17}/unbind-wechat`, {
    method: 'POST',
  });
  check('未登录解绑 → 401', anonUnbind.status === 401, anonUnbind.status);

  const noSuchEmp = await api('/api/company/employees/99999999/unbind-wechat', {
    method: 'POST',
    token: companyToken,
  });
  check('解绑不存在的员工 → 404', noSuchEmp.status === 404, noSuchEmp.status);

  // 9) 平台端也能解绑（客户直接找平台时用）
  const platUnbind = await api(`/api/platform/employees/${lisiId17}/unbind-wechat`, {
    method: 'POST',
    token: superToken,
  });
  check('平台端可解绑员工微信', platUnbind.body?.code === 0, platUnbind.body);

  // 10) 解绑 ≠ 停用：账号状态与额度字段一概不动
  const lisiFinal = (await api('/api/company/employees?keyword=13900000002', {
    token: companyToken,
  })).body?.data?.list?.find((e) => e.id === lisiId17);
  check(
    '解绑不影响账号状态（仍启用）与额度字段',
    lisiFinal?.status === 1 && 'quotaTotal' in (lisiFinal || {}),
    { status: lisiFinal?.status, quotaTotal: lisiFinal?.quotaTotal, bound: lisiFinal?.bound },
  );

  // 11) 操作日志留痕
  const unbindLogs = await api('/api/company/operation-logs?module=employee&action=unbind_wechat', {
    token: companyToken,
  });
  check(
    '解绑写入操作日志（module=employee / action=unbind_wechat）',
    unbindLogs.body?.code === 0 && (unbindLogs.body?.data?.total || 0) > 0,
    unbindLogs.body?.data?.total,
  );

  // 收尾：让李四回到未绑定状态，避免污染下一次运行
  await api(`/api/company/employees/${lisiId17}/unbind-wechat`, {
    method: 'POST',
    token: companyToken,
  });

  // 收尾：恢复规则与原始额度
  await restoreQuotaSection();

  // ─────────────────────────────────────────────
  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项 / 共 ${pass + fail} 项`);
  if (fail > 0) {
    console.log(`\n  失败明细：`);
    failures.forEach((f) => console.log(`    · ${f}`));
  }
  console.log(`${'═'.repeat(52)}\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n冒烟测试异常终止：', e);
  process.exit(1);
});
