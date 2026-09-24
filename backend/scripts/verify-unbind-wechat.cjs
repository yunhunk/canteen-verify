/**
 * 端到端验证「查看微信绑定状态 + 解绑微信」（公司端 + 平台端）。
 *
 * 前置：员工 1（13900000001）已被预置假 openid（test-mock-openid-unbind-verify），
 *       模拟"已绑定微信"。验证完成后该员工回到未绑定态，不影响真实员工
 *       （员工 3 = 13900000003 是现场正在用的账号，脚本只读不断绑）。
 *
 * 用法：node scripts/verify-unbind-wechat.cjs [BASE_URL]
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
  console.log(`\n═══ 微信绑定查看/解绑验证 @ ${BASE} ═══`);

  // 1. 两端登录（公司端与平台端共用 /api/auth/admin/login，按 role 分流）
  const superLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123456' },
  });
  const superToken = superLogin.body?.data?.token;
  check('平台端登录（admin）', !!superToken, JSON.stringify(superLogin.body).slice(0, 120));

  const companyLogin = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'company_a', password: 'company123456' },
  });
  const companyToken = companyLogin.body?.data?.token;
  check('公司端登录（company_a）', !!companyToken, JSON.stringify(companyLogin.body).slice(0, 120));
  if (!superToken || !companyToken) {
    console.log(`\n通过 ${pass} / 失败 ${fail}（登录失败，终止）`);
    process.exit(fail ? 1 : 0);
    return;
  }

  // 2. 公司端列表：绑定状态可见（员工1 已被预置假 openid）
  const cList = await api('/api/company/employees?page=1&pageSize=50', { token: companyToken });
  const cRows = cList.body?.data?.list || [];
  const cE1 = cRows.find((r) => r.phone === '13900000001');
  const cE2 = cRows.find((r) => r.phone === '13900000002');
  check('公司端列表返回 bound 字段', cRows.length > 0 && cE1 && typeof cE1.bound === 'boolean',
    JSON.stringify(cList.body).slice(0, 120));
  check('公司端可见「已绑定」（员工1）', cE1?.bound === true,
    `bound=${cE1?.bound}`);
  check('公司端可见「未绑定」（员工2）', cE2?.bound === false,
    `bound=${cE2?.bound}`);

  // 3. 公司端解绑员工1 —— 主场景
  const unbind = await api('/api/company/employees/1/unbind-wechat', {
    method: 'POST',
    token: companyToken,
  });
  check('公司端解绑员工1成功',
    unbind.body?.code === 0 && unbind.body?.data?.bound === false,
    JSON.stringify(unbind.body).slice(0, 160));

  // 4. 解绑后列表立即反映为未绑定
  const cList2 = await api('/api/company/employees?page=1&pageSize=50', { token: companyToken });
  const cE1b = (cList2.body?.data?.list || []).find((r) => r.phone === '13900000001');
  check('解绑后列表显示未绑定', cE1b?.bound === false, `bound=${cE1b?.bound}`);

  // 5. 重复解绑必须报错（防止管理员以为清掉了，实际没绑过/并发已解）
  const unbindAgain = await api('/api/company/employees/1/unbind-wechat', {
    method: 'POST',
    token: companyToken,
  });
  check('重复解绑被拒绝（尚未绑定微信）', unbindAgain.body?.code !== 0,
    JSON.stringify(unbindAgain.body).slice(0, 120));

  // 6. 租户隔离：公司1 的管理员不能动公司2 的员工3
  const cross = await api('/api/company/employees/3/unbind-wechat', {
    method: 'POST',
    token: companyToken,
  });
  check('公司端不能解绑其他公司员工', cross.body?.code !== 0,
    JSON.stringify(cross.body).slice(0, 120));

  // 7. 平台端列表：跨公司可见绑定状态（员工1 已解绑=false；员工3 现场在用=true，只读）
  const pList = await api('/api/platform/employees?page=1&pageSize=50', { token: superToken });
  const pRows = pList.body?.data?.list || [];
  const pE1 = pRows.find((r) => r.phone === '13900000001');
  const pE3 = pRows.find((r) => r.phone === '13900000003');
  check('平台端列表返回 bound 字段（含公司名）',
    pRows.length > 0 && pE1 && typeof pE1.bound === 'boolean' && 'companyName' in pE1,
    JSON.stringify(pList.body).slice(0, 120));
  check('平台端确认员工1 已解绑', pE1?.bound === false, `bound=${pE1?.bound}`);
  check('平台端确认员工3 绑定状态可见（未动它）', pE3?.bound === true, `bound=${pE3?.bound}`);

  // 8. 平台端跨公司解绑通道可用：对未绑定的员工2 报「尚未绑定」即证明路由+权限通
  const pUnbind = await api('/api/platform/employees/2/unbind-wechat', {
    method: 'POST',
    token: superToken,
  });
  check('平台端解绑接口可用（未绑定报错符合预期）', pUnbind.body?.code !== 0,
    JSON.stringify(pUnbind.body).slice(0, 120));

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  通过 ${pass} / 失败 ${fail}`);
  console.log(`${'═'.repeat(50)}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
