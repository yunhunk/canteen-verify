/**
 * 静态契约护栏：比对「前端调用 ↔ 后端路由」
 *
 * 拦截的是"前端调了一个不存在的接口"这类错误 —— 它只在运行时才暴露，
 * 而且要等到用户点到那个页面才发现。
 *
 * 做法：
 * 1. 从 dist 编译产物里提取 NestJS 路由全量清单（比正则扫源码更准，
 *    因为 @Controller 前缀 + @Get/@Post 的拼接由框架完成）
 * 2. 从 miniprogram/ 与 admin-web/ 里提取所有接口调用路径
 * 3. 逐条比对
 *
 * 用法：node scripts/check-miniapp.js（或 backend/ 下 npm run check:miniapp）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROJECT_ROOT = path.join(ROOT, '..');

let pass = 0;
let fail = 0;
const problems = [];

function ok(name) {
  pass++;
  console.log(`  ✓ ${name}`);
}
function bad(name, detail) {
  fail++;
  problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ✗ ${name}${detail ? ` → ${detail}` : ''}`);
}
function section(t) {
  console.log(`\n── ${t}`);
}

// ─────────────────────────────────────────────
// 1. 提取后端路由（用 Nest 的元数据，最贴近运行时）
// ─────────────────────────────────────────────

/**
 * 从源码解析出「类 → 路由」映射。
 *
 * 注意：一个 .controller.ts 里可以有**多个** @Controller 类
 * （例如 employee.controller.ts 同时定义了 /api/company、/api/platform 与 /api/employee）。
 * 若全文只取第一个 @Controller 前缀，会把 employee 的接口全部误算到 company 名下，
 * 契约检查就会给出假阳性。因此这里必须先按类边界切分，再逐段取前缀。
 *
 * 切分方式：把 @Controller 装饰器与它后面第一个 export class 视为一组，
 * 主体范围 = 该 class 声明处 → 下一个 @Controller 装饰器处（或文件末尾）。
 */
function parseControllerFile(src) {
  const ctrlRe = /@Controller\(\s*['"`]([^'"`]*)['"`]\s*\)/g;
  const classRe = /export\s+class\s+\w+/g;

  const ctrls = [];
  let c;
  while ((c = ctrlRe.exec(src)) !== null) ctrls.push({ index: c.index, prefix: c[1] });
  if (ctrls.length === 0) return [];

  const classPositions = [];
  let k;
  while ((k = classRe.exec(src)) !== null) classPositions.push(k.index);

  return ctrls.map((ctrl, i) => {
    // 该 @Controller 之后第一个 class 即它装饰的类
    const classStart = classPositions.find((p) => p > ctrl.index);
    if (classStart === undefined) return null;

    // 主体截止到「下一个 @Controller 的位置」或文件末尾。
    // 不能用下一个 class 起点 —— 会把该类自己的方法全部截掉。
    const nextCtrl = i + 1 < ctrls.length ? ctrls[i + 1].index : src.length;

    return { prefix: ctrl.prefix, body: src.slice(classStart, nextCtrl) };
  }).filter(Boolean);
}

function extractBackendRoutes() {
  const routes = new Set();

  const srcDir = path.join(ROOT, 'src');
  const controllers = [];

  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else if (f.name.endsWith('.controller.ts')) controllers.push(full);
    }
  })(srcDir);

  for (const file of controllers) {
    const src = fs.readFileSync(file, 'utf8');

    for (const { prefix, body } of parseControllerFile(src)) {
      // 逐个方法找 HTTP 动词装饰器
      const methodRe = /@(Get|Post|Put|Delete|Patch)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
      let m;
      while ((m = methodRe.exec(body)) !== null) {
        const verb = m[1].toUpperCase();
        const sub = m[2] || '';
        const full = normalizePath(`${prefix}/${sub}`);
        routes.add(`${verb} ${full}`);
      }
    }
  }

  return routes;
}

/** 归一化路径：去掉首尾多余斜杠、把 :param 统一成 :param */
function normalizePath(p) {
  let out = p.replace(/\/+/g, '/');
  if (!out.startsWith('/')) out = '/' + out;
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

// ─────────────────────────────────────────────
// 2. 提取前端调用
// ─────────────────────────────────────────────

/** 把前端调用路径里的模板变量/拼接值统一成 :param，便于与后端路由比对 */
function maskDynamic(p) {
  return p
    // ${...} 模板插值
    .replace(/\$\{[^}]*\}/g, ':param')
    // 显式拼接的 id，如 /employees/' + id
    .replace(/['"\s]*\+\s*[^/'"?\s]+/g, ':param');
}

function extractFrontendCalls(dir, label) {
  const calls = [];
  if (!fs.existsSync(dir)) return calls;

  const exts = ['.js', '.ts', '.vue', '.wxml'];

  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.name === 'node_modules' || f.name === 'dist' || f.name === '.git') continue;
      const full = path.join(d, f.name);
      if (f.isDirectory()) {
        walk(full);
      } else if (exts.some((e) => f.name.endsWith(e))) {
        const src = fs.readFileSync(full, 'utf8');
        const rel = path.relative(PROJECT_ROOT, full).replace(/\\/g, '/');

        // 匹配 request({ url: '/api/...' }) / request('/api/...') / api.get('/api/...')
        // 以及 WX 的 wx.request({ url: `${BASE}/api/...` })
        const re = /(?:url\s*:\s*|request(?:\.\w+)?\s*\(\s*|api\s*\.\s*\w+\s*\(\s*)['"`](\/api\/[^'"`]*)['"`]/g;
        let m;
        while ((m = re.exec(src)) !== null) {
          calls.push({ path: normalizePath(maskDynamic(m[1])), file: rel, label });
        }

        // 反引号模板里直接写 ${BASE}/api/xxx 的情况
        const re2 = /['"`](\/api\/[^'"`]+)['"`]/g;
        while ((m = re2.exec(src)) !== null) {
          const p = normalizePath(maskDynamic(m[1]));
          if (!calls.some((c) => c.path === p && c.file === rel)) {
            calls.push({ path: p, file: rel, label });
          }
        }
      }
    }
  })(dir);

  return calls;
}

// ─────────────────────────────────────────────
// 3. 比对
// ─────────────────────────────────────────────

/**
 * 管理后台的接口路径集中在 src/api/*.js 里通过 http.get(...) 声明，
 * 调用点（.vue）全部走封装后的函数名，**不存在 '/api/xxx' 字面量**。
 *
 * 因此对 admin-web 不能复用「扫调用点」的方式 —— 那样永远扫不到东西，
 * 检查会变成一条永远亮红灯的摆设。改为直接扫 api/ 声明表。
 */
function extractAdminApiDeclarations(dir) {
  const apiDir = path.join(dir, 'src', 'api');
  const calls = [];
  if (!fs.existsSync(apiDir)) return calls;

  for (const f of fs.readdirSync(apiDir)) {
    if (!f.endsWith('.js')) continue;
    const rel = path.relative(PROJECT_ROOT, path.join(apiDir, f)).replace(/\\/g, '/');
    const src = fs.readFileSync(path.join(apiDir, f), 'utf8');

    // http.get('/x') / http.post('/x') / http.put('/x') / http.delete('/x') / download('/x', ...)
    const re = /(?:http\.(get|post|put|delete|patch)|download)\(\s*(['"`])((?:\/api\/)?[^'"`]*)\2/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const verb = m[1] ? m[1].toUpperCase() : 'GET';
      let p = m[3];
      if (!p.startsWith('/api/')) p = '/api' + (p.startsWith('/') ? p : '/' + p);
      calls.push({ verb, path: normalizePath(maskDynamic(p)), file: rel, label: 'admin-web' });
    }
  }

  return calls;
}

/**
 * 把实际路径转成候选集合：/a/5/b → 也尝试匹配后端 /a/:id/b
 *
 * @param {string} callPath 前端调用的路径
 * @param {Set<string>} routes 后端路由（形如 "GET /api/x/:id"）
 * @param {string} [verb] 可选。给了动词就要求动词也对上；
 *   小程序那批调用点扫不到动词（路径是字面量、动词在封装里），所以可不传。
 */
function matchesRoute(callPath, routes, verb) {
  // 直接命中
  if (verb && routes.has(`${verb} ${callPath}`)) return true;
  if (!verb && routes.has(callPath)) return true;

  // 按段比对，把前端的具体值视为通配
  const segments = callPath.split('/').filter(Boolean);
  for (const route of routes) {
    const [rVerb, rPath] = splitRoute(route);
    if (verb && rVerb !== verb) continue;

    const rSegs = rPath.split('/').filter(Boolean);
    if (rSegs.length !== segments.length) continue;

    let matched = true;
    for (let i = 0; i < rSegs.length; i++) {
      const r = rSegs[i];
      const c = segments[i];
      if (r.startsWith(':')) continue; // 后端参数位，任意值都行
      if (r !== c) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function splitRoute(route) {
  const idx = route.indexOf(' ');
  return [route.slice(0, idx), route.slice(idx + 1)];
}

function main() {
  console.log('\n═══ 前端调用 ↔ 后端路由 一致性检查 ═══');

  const routes = extractBackendRoutes();
  section('1. 后端路由清单');
  ok(`提取到 ${routes.size} 条后端路由`);

  const miniDir = path.join(PROJECT_ROOT, 'miniprogram');
  const adminDir = path.join(PROJECT_ROOT, 'admin-web');

  const miniCalls = extractFrontendCalls(miniDir, 'miniprogram');
  // 管理后台的路径集中在 src/api/ 声明，调用点没有字面量，必须换一种扫法
  const adminCalls = extractAdminApiDeclarations(adminDir);

  section('2. 员工端小程序接口调用');
  if (!fs.existsSync(miniDir)) {
    console.log('  (miniprogram/ 目录不存在，跳过)');
  } else if (miniCalls.length === 0) {
    bad('未提取到任何小程序接口调用（目录存在但无调用？）');
  } else {
    ok(`提取到 ${miniCalls.length} 处接口调用`);
    const unmatched = miniCalls.filter((c) => !matchesRoute(c.path, routes));
    if (unmatched.length === 0) {
      ok(`全部 ${miniCalls.length} 处调用均能匹配到后端路由`);
    } else {
      for (const u of unmatched) {
        bad(`未匹配的后端路由`, `${u.path}  (${u.file})`);
      }
    }
  }

  section('3. 管理后台接口调用');
  if (!fs.existsSync(adminDir)) {
    console.log('  (admin-web/ 目录不存在，跳过)');
  } else if (adminCalls.length === 0) {
    bad('未提取到任何后台接口调用');
  } else {
    ok(`提取到 ${adminCalls.length} 处接口调用`);
    const unmatched = adminCalls.filter((c) => !matchesRoute(c.path, routes, c.verb));
    if (unmatched.length === 0) {
      ok(`全部 ${adminCalls.length} 处调用均能匹配到后端路由`);
    } else {
      for (const u of unmatched) {
        bad(`未匹配的后端路由`, `${u.verb || ''} ${u.path}  (${u.file})`);
      }
    }
  }

  section('4. 小程序结构完整性');
  if (fs.existsSync(miniDir)) {
    const appJsonPath = path.join(miniDir, 'app.json');
    if (fs.existsSync(appJsonPath)) {
      let appJson = null;
      try {
        appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
        ok('app.json 可解析');
      } catch (e) {
        bad('app.json 解析失败', e.message);
      }

      if (appJson?.pages) {
        let ok4 = 0;
        for (const page of appJson.pages) {
          const base = path.join(miniDir, page);
          const missing = ['.js', '.json', '.wxml', '.wxss'].filter(
            (ext) => !fs.existsSync(base + ext),
          );
          if (missing.length === 0) ok4++;
          else bad(`页面 ${page} 四件套不全`, `缺少 ${missing.join(', ')}`);
        }
        if (ok4 === appJson.pages.length) {
          ok(`${appJson.pages.length} 个页面四件套齐全`);
        }
      }

      // tabBar 指向必须在 pages 里
      if (appJson?.tabBar?.list) {
        const pages = new Set(appJson.pages || []);
        const badTabs = appJson.tabBar.list.filter((t) => !pages.has(t.pagePath));
        if (badTabs.length === 0) {
          ok(`tabBar ${appJson.tabBar.list.length} 项均指向已声明页面`);
        } else {
          bad('tabBar 指向未声明的页面', badTabs.map((t) => t.pagePath).join(', '));
        }
      }
    } else {
      bad('缺少 app.json');
    }

    const sitemap = path.join(miniDir, 'sitemap.json');
    if (fs.existsSync(sitemap)) {
      try {
        JSON.parse(fs.readFileSync(sitemap, 'utf8'));
        ok('sitemap.json 可解析');
      } catch (e) {
        bad('sitemap.json 解析失败', e.message);
      }
    }
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项`);
  if (problems.length) {
    console.log('\n  问题清单：');
    problems.forEach((p) => console.log(`    · ${p}`));
  }
  console.log(`${'═'.repeat(52)}\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main();
