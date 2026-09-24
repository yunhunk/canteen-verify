/**
 * 后台接口自检：确认 src/api/ 里声明的路径都能在后端路由表里找到。
 *
 * 与 backend/scripts/check-miniapp.js 的关系：
 * 那个脚本从「调用点」反查（扫代码里的 http.get(...) 字面量），
 * 这个脚本从「声明表」正查（只扫 api/ 目录），能覆盖到被封装后
 * 不再出现字面量的场景，例如 `http.put(`/platform/devices/${id}`, data)` 拼出来的路径。
 *
 * 用法：node scripts/check-api.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROJECT_ROOT = path.join(ROOT, '..');
const BACKEND_SRC = path.join(PROJECT_ROOT, 'backend', 'src');

let pass = 0;
let fail = 0;
const problems = [];

const ok = (n) => {
  pass++;
  console.log(`  ✓ ${n}`);
};
const bad = (n, d) => {
  fail++;
  problems.push(`${n}${d ? ` — ${d}` : ''}`);
  console.log(`  ✗ ${n}${d ? ` → ${d}` : ''}`);
};

// ── 后端路由（与 check-miniapp.js 同一套解析逻辑，按类边界切分）──
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

  return ctrls
    .map((ctrl, i) => {
      const classStart = classPositions.find((p) => p > ctrl.index);
      if (classStart === undefined) return null;
      const nextCtrl = i + 1 < ctrls.length ? ctrls[i + 1].index : src.length;
      return { prefix: ctrl.prefix, body: src.slice(classStart, nextCtrl) };
    })
    .filter(Boolean);
}

function normalizePath(p) {
  let out = p.replace(/\/+/g, '/');
  if (!out.startsWith('/')) out = '/' + out;
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

function extractBackendRoutes() {
  const routes = new Set();

  const controllers = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else if (f.name.endsWith('.controller.ts')) controllers.push(full);
    }
  })(BACKEND_SRC);

  for (const file of controllers) {
    const src = fs.readFileSync(file, 'utf8');
    for (const { prefix, body } of parseControllerFile(src)) {
      const re = /@(Get|Post|Put|Delete|Patch)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
      let m;
      while ((m = re.exec(body)) !== null) {
        routes.add(`${m[1].toUpperCase()} ${normalizePath(`${prefix}/${m[2] || ''}`)}`);
      }
    }
  }
  return routes;
}

// ── 前端 api/ 声明 ──
function extractApiDeclarations() {
  const dir = path.join(ROOT, 'src', 'api');
  const calls = [];

  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');

    // 匹配 http.get('/xxx') / http.post('/xxx') / download('/xxx', ...)
    const re = /(?:http\.(get|post|put|delete|patch)|download)\(\s*(['"`])((?:\/api\/)?[^'"`]*)\2/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      let verb = m[1] ? m[1].toUpperCase() : 'GET';
      let p = m[3];

      if (!p.startsWith('/api/')) p = '/api' + (p.startsWith('/') ? p : '/' + p);

      // 把 ${...} 模板插值归一成 :param
      p = p.replace(/\$\{[^}]*\}/g, ':param');

      calls.push({ verb, path: normalizePath(p), file: `src/api/${f}` });
    }
  }
  return calls;
}

function matches(call, routes) {
  const key = `${call.verb} ${call.path}`;
  if (routes.has(key)) return true;

  const segs = call.path.split('/').filter(Boolean);
  for (const route of routes) {
    const idx = route.indexOf(' ');
    const verb = route.slice(0, idx);
    const rPath = route.slice(idx + 1);
    if (verb !== call.verb) continue;

    const rs = rPath.split('/').filter(Boolean);
    if (rs.length !== segs.length) continue;

    let hit = true;
    for (let i = 0; i < rs.length; i++) {
      if (rs[i].startsWith(':')) continue;
      if (rs[i] !== segs[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

function main() {
  console.log('\n═══ 后台接口声明 ↔ 后端路由 一致性检查 ═══\n');

  if (!fs.existsSync(BACKEND_SRC)) {
    console.log('  (找不到 backend/src，跳过)\n');
    process.exit(0);
  }

  const routes = extractBackendRoutes();
  ok(`后端路由 ${routes.size} 条`);

  const calls = extractApiDeclarations();
  if (calls.length === 0) {
    bad('未从 src/api/ 提取到任何接口声明');
  } else {
    ok(`前端声明 ${calls.length} 处接口`);

    const unmatched = calls.filter((c) => !matches(c, routes));
    if (unmatched.length === 0) {
      ok(`全部 ${calls.length} 处声明均能匹配到后端路由`);
    } else {
      for (const u of unmatched) {
        bad('未匹配', `${u.verb} ${u.path}  (${u.file})`);
      }
    }
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项`);
  if (problems.length) {
    console.log('\n  问题清单：');
    problems.forEach((p) => console.log(`    · ${p}`));
  }
  console.log(`${'═'.repeat(50)}\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main();
