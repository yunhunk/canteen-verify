/**
 * 扫码核销 App 接口契约验证 —— Node 等价实现
 *
 * 本机没有 Android SDK，App 无法编译运行。但 App 的网络层
 * （ApiClient + VerifyResult 模型）只是"发请求 + 认字段"，
 * 这部分完全可以用 Node 等价复刻：用**同样的请求体**打后端，
 * 按**同样的字段名**解析响应，逐项断言。
 *
 * 脚本通过 = App 网络层面对的接口契约是真实成立的；
 * 脚本不通过 = App 装上也是白装，必须先修。
 *
 * 覆盖的 App 行为：
 *   1. checkDeviceKey：探测密钥（App 绑定页的校验逻辑）
 *   2. 核销成功：VerifyResult 的全部 15 个字段逐一断言
 *   3. 设备绑店优先：绑店设备的核销落点不受请求参数影响
 *   4. 失败路径：重复核销 2001 / 无效码 2001 / 密钥无效 2006
 *   5. voiceText：App 直接念后端给的播报文本，这里验证其格式
 *
 * 用法：先启动本地服务（LOCAL_MODE=1 PORT=3311），再
 *       node verify-api-contract.cjs
 * 可用环境变量 BASE 覆盖目标地址（如指向生产需自担数据风险）。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3311';

/**
 * 测试凭据（漏洞 724a4/50b9f）：一律从环境变量取，脚本内不留明文口令/密钥。
 * 默认值是**本地演示种子**的公开值（见 backend/src/database/ensure-database.ts），
 * 不是任何真实环境的秘密；指向生产时请用环境变量覆盖。
 */
const SEED_SUPER_PASSWORD = process.env.SEED_SUPER_PASSWORD || 'admin123456';
const SEED_COMPANY_PASSWORD = process.env.SEED_COMPANY_PASSWORD || 'company123456';
const DEVICE_KEY_1 = process.env.SEED_DEVICE_KEY_1 || 'device-key-demo-0001';
const DEVICE_KEY_2 = process.env.SEED_DEVICE_KEY_2 || 'device-key-demo-0002';

let pass = 0;
let fail = 0;
const problems = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    problems.push(name + (extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''));
    console.log(`  ✗ ${name}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`);
  }
}

function section(t) {
  console.log(`\n── ${t}`);
}

/**
 * 与 App 端 ApiClient 完全同构的请求函数。
 * 统一响应包 { code, message, data }，业务失败不抛异常、
 * 只有网络层异常才抛 —— 与 ApiClient.kt 的注释逐字对应。
 */
async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

/**
 * 复刻 App 的 checkDeviceKey：
 * 拿假 token 探测，按错误码类型判断密钥是否有效（2006 = 无效）。
 */
async function checkDeviceKey(deviceKey) {
  const r = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey, qrToken: '__key_probe__', storeId: null },
  });
  const code = r.body?.code;
  if (code === 2006) return { valid: false, message: r.body?.message };
  if (r.body && typeof r.body.code === 'number') return { valid: true };
  return { valid: false, message: '响应不是统一格式' };
}

/** VerifyResult 应有的全部字段（与 VerifyModels.kt 的 @SerializedName 一一对应） */
const VERIFY_RESULT_FIELDS = [
  'success',
  'consumptionId',
  'employeeId',
  'employeeName',
  'companyId',
  'storeId',
  'storeName',
  'verifyTime',
  'remainQuota',
  'employeeQuotaTotal',
  'employeeQuotaUsed',
  'employeeQuotaRemain',
  'mealStandard',
  'voiceText',
  'window',
];

async function main() {
  console.log('\n═══ 扫码核销 App 接口契约验证 ═══');
  console.log(`目标：${BASE}`);
  console.log('（等价复刻 App 网络层：同样请求体、同样字段名、同样错误码分支）');

  // ─────────────────────────────────────────────
  section('0. 服务可达性');
  const ping = await api('/api/platform/companies');
  check(
    '服务可达且返回统一响应包 { code, message, data }',
    ping.body && 'code' in ping.body && 'message' in ping.body && 'data' in ping.body,
    ping.body,
  );

  // ─────────────────────────────────────────────
  section('1. 设备密钥校验（App 绑定页逻辑）');

  const goodKey = await checkDeviceKey(DEVICE_KEY_1);
  check('有效密钥探测 → 校验通过（非 2006）', goodKey.valid === true, goodKey);

  const badKey = await checkDeviceKey('this-key-does-not-exist-at-all');
  check('无效密钥探测 → 2006 拒绝', badKey.valid === false, badKey);

  const noKey = await api('/api/device/verify', {
    method: 'POST',
    body: { qrToken: '__key_probe__' },
  });
  check('缺密钥 → 2006', noKey.body?.code === 2006, noKey.body?.code);
  check('错误码语义正确（2006=设备无效）', noKey.body?.code === 2006, noKey.body?.message);

  // ─────────────────────────────────────────────
  section('2. 准备数据（平台/公司/员工）');

  const superLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: SEED_SUPER_PASSWORD },
  });
  const superToken = superLogin.body?.data?.token;
  check('平台超管登录', !!superToken, superLogin.body);

  const companies = await api('/api/platform/companies', { token: superToken });
  const list = companies.body?.data?.list || companies.body?.data || [];
  check('公司清单可读', list.length >= 2, list.map((c) => c.name));

  const stores = await api('/api/platform/stores', { token: superToken });
  const storeList = Array.isArray(stores.body?.data) ? stores.body.data : [];
  const store1 = storeList.find((s) => s.name === '总部食堂');
  const store2 = storeList.find((s) => s.name === '研发中心餐厅');
  check('门店清单可读（总部食堂/研发中心餐厅）', !!store1 && !!store2, storeList.map((s) => s.name));

  // 员工登录（本地 mock openid）→ 出码。
  // 公司归属从登录响应里拿 —— 不依赖种子里公司的名字
  const empLogin = await api('/api/auth/employee/login', {
    method: 'POST',
    body: { code: `scan-app-${Date.now()}`, phone: '13900000003' },
  });
  const empToken = empLogin.body?.data?.token;
  check('员工王五微信登录（mock）', !!empToken, empLogin.body);
  const empCompanyId = empLogin.body?.data?.user?.companyId;
  const companyB = list.find((c) => String(c.id) === String(empCompanyId));
  check('定位王五所属公司', !!companyB, { empCompanyId, names: list.map((c) => c.name) });

  // 设餐标 15 元 —— 验证 voiceText 的拼接（App 直接念这串文本）
  const setMeal = await api(`/api/platform/companies/${companyB.id}/meal-standard`, {
    method: 'PUT',
    token: superToken,
    body: { mealStandard: 15 },
  });
  check('平台为该公司设置餐标 15 元', setMeal.body?.code === 0, setMeal.body);

  async function issueQr() {
    const r = await api('/api/employee/qrcode', { token: empToken });
    return r.body?.data?.qrToken;
  }

  // ─────────────────────────────────────────────
  section('3. 核销成功 —— VerifyResult 全字段契约');

  const qr1 = await issueQr();
  check('员工出码成功', typeof qr1 === 'string' && qr1.length >= 16, qr1);

  const v1 = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: DEVICE_KEY_2, qrToken: qr1 },
  });

  check('核销成功 code=0', v1.body?.code === 0, v1.body);
  const d = v1.body?.data || {};

  // 逐字段断言：App 的 VerifyResult 模型靠这些名字反序列化，
  // 任何一个对不上，App 里读到的就是 null
  for (const f of VERIFY_RESULT_FIELDS) {
    check(`字段存在：${f}`, f in d, { keys: Object.keys(d) });
  }

  check('success = true', d.success === true, d.success);
  check('employeeName = 王五', d.employeeName === '王五', d.employeeName);
  check('consumptionId 是非空字符串', typeof d.consumptionId === 'string' && d.consumptionId.length > 0, d.consumptionId);
  check('verifyTime 非空', !!d.verifyTime, d.verifyTime);
  check('remainQuota 是数字且 > 0', typeof d.remainQuota === 'number' && d.remainQuota > 0, d.remainQuota);

  // B 公司员工未设个人额度 → null（App 显示「不限」）
  check('employeeQuotaTotal = null（未设限）', d.employeeQuotaTotal === null, d.employeeQuotaTotal);
  check('employeeQuotaRemain = null（未设限）', d.employeeQuotaRemain === null, d.employeeQuotaRemain);

  check('mealStandard = 15（刚设置的餐标）', Number(d.mealStandard) === 15, d.mealStandard);

  // voiceText：App 的 TTS 直接念这串 —— 必须精确匹配服务端拼接规则
  check(
    'voiceText = 「核销成功，餐标15元」（金额去尾零）',
    d.voiceText === '核销成功，餐标15元',
    d.voiceText,
  );

  // B 公司此时无时段规则 → 不限时段，window 为 null
  check('window = null（公司未配规则）', d.window === null, d.window);

  // 不绑店设备 + 未传 storeId → 门店为空
  check('storeName = null（设备未绑店且未传门店）', d.storeId === null && d.storeName === null, {
    storeId: d.storeId,
    storeName: d.storeName,
  });

  // ─────────────────────────────────────────────
  section('4. 设备绑店优先于请求参数（防跨店冒充）');

  const qr2 = await issueQr();
  const v2 = await api('/api/device/verify', {
    method: 'POST',
    body: {
      deviceKey: DEVICE_KEY_1, // 绑定「总部食堂」的设备
      qrToken: qr2,
      storeId: String(store2.id), // 恶意传另一家门店
    },
  });
  check('核销成功', v2.body?.code === 0, v2.body);
  check(
    '门店落点 = 设备绑定门店（总部食堂），请求参数被忽略',
    String(v2.body?.data?.storeId) === String(store1.id),
    { expected: store1.id, actual: v2.body?.data?.storeId },
  );
  check('storeName 回传「总部食堂」', v2.body?.data?.storeName === '总部食堂', v2.body?.data?.storeName);

  // ─────────────────────────────────────────────
  section('5. 时段信息回传（window 对象契约）');

  // 给 B 公司配「全天不限」规则 → 核销结果应带 window
  const bLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'company_b', password: SEED_COMPANY_PASSWORD },
  });
  const bToken = bLogin.body?.data?.token;
  check('B 公司管理员登录', !!bToken, bLogin.body);

  const makeRule = await api('/api/company/rules', {
    method: 'POST',
    token: bToken,
    body: { name: '全天', startTime: '00:00', endTime: '23:59', perEmployeeLimit: 0 },
  });
  check('创建「全天不限」规则', makeRule.body?.code === 0, makeRule.body);

  const qr3 = await issueQr();
  const v3 = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: DEVICE_KEY_2, qrToken: qr3 },
  });
  check('核销成功', v3.body?.code === 0, v3.body);
  const w = v3.body?.data?.window;
  check('window 非空（命中全天规则）', !!w, w);
  check('window.name = 全天', w?.name === '全天', w?.name);
  check('window.limit = 0（不限）', Number(w?.limit) === 0, w?.limit);
  check('window.remain = null（不限时段的约定）', w?.remain === null, w?.remain);
  check('window.used = 1（本次是第 1 次）', Number(w?.used) === 1, w?.used);
  check(
    'window.text 含时段区间（App 结果页展示用）',
    typeof w?.text === 'string' && w.text.includes('00:00'),
    w?.text,
  );

  // ─────────────────────────────────────────────
  section('6. 失败路径（App 的失败分支全部依赖这些错误码）');

  const dup = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: DEVICE_KEY_2, qrToken: qr3 },
  });
  check('同一码二次核销 → 2001（App 提示「请员工刷新」）', dup.body?.code === 2001, dup.body?.code);

  const badToken = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: DEVICE_KEY_2, qrToken: 'not-a-real-token' },
  });
  check('伪造二维码 → 2001', badToken.body?.code === 2001, badToken.body?.code);

  const badKeyVerify = await api('/api/device/verify', {
    method: 'POST',
    body: { deviceKey: 'wrong-key-xyz', qrToken: qr1 },
  });
  check('无效密钥核销 → 2006（App 弹「重新绑定」）', badKeyVerify.body?.code === 2006, badKeyVerify.body?.code);

  // HTTP 状态与业务码分离：业务失败给 4xx 但 body 带业务码
  check('业务失败仍返回可解析的 JSON（HTTP 400 + 业务码）', dup.status === 400 && dup.body?.code === 2001, {
    http: dup.status,
    biz: dup.body?.code,
  });

  // ─────────────────────────────────────────────
  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项`);
  if (problems.length) {
    console.log('\n  问题清单：');
    problems.forEach((p) => console.log(`    · ${p}`));
  }
  console.log(`${'═'.repeat(52)}\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n契约验证脚本异常：', e.message);
  process.exit(1);
});
