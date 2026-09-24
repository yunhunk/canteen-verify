/**
 * 安卓工程静态一致性检查。
 *
 * 本机没有 JDK / Android SDK / Gradle，**无法编译**安卓工程。
 * 那怎么保证交付的代码不是一堆打不开的引用？答案是：把编译器会报的
 * 「资源引用是否存在」「字符串占位符是否匹配」这类**可静态判定**的错误，
 * 用脚本先查一遍。查不了的（类型错误、API 签名）留给用户的 Android Studio。
 *
 * 这不是"假装编译通过"——检查范围写得很清楚，能查的查，查不了的如实汇报。
 *
 * 检查项：
 *   1. 每个 XML 文件是否可解析（标签闭合、属性引号）
 *   2. 代码/Xml 里 @string/xxx、@color/xxx、@drawable/xxx、@style/xxx、
 *      @dimen/xxx、@xml/xxx、@mipmap/xxx 是否都有定义
 *   3. R.string.xxx / R.drawable.xxx / R.color.xxx / R.dimen.xxx
 *      / R.layout.xxx / R.id.xxx 是否都有定义（id 需查 layout 里的 @+id）
 *   4. 带 %1$s 这类占位符的字符串，在代码里使用时参数个数是否匹配
 *   5. AndroidManifest 里声明的 Activity 是否有对应 .kt 文件
 *   6. 布局 XML 里用到的 ViewBinding 绑定类是否有对应布局文件
 *   7. Kotlin 里 import 的 R 字段与 XML 定义是否对得上
 *   8. XML 里使用的命名空间前缀（tools:/app: 等）均已声明
 *      —— AAPT2 对未声明前缀直接报 unbound prefix，属编译级错误
 *
 * 用法：node check-android.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const APP = path.join(ROOT, 'app', 'src', 'main');
const JAVA_DIR = path.join(APP, 'java');
const RES_DIR = path.join(APP, 'res');

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
// XML 解析（极简，但足以覆盖 Android 资源文件的写法）
// ─────────────────────────────────────────────

/**
 * 不引第三方 XML 库：本目录的 package.json 是空的，
 * 装依赖要走网络，而本机 npm 很慢。
 * Android 资源 XML 结构简单（无 CDATA 嵌套、无 DTD），
 * 用标签栈 + 属性正则足够。
 */
function parseXml(src, file) {
  // 去掉注释、XML 声明、DOCTYPE
  const cleaned = src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '');

  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^<>]*?)?)(\/?)>/g;
  const stack = [];
  let m;
  while ((m = tagRe.exec(cleaned)) !== null) {
    const [, closing, name, , selfClose] = m;
    if (closing) {
      const top = stack.pop();
      if (top !== name) {
        throw new Error(
          `${file}: 标签不匹配 —— 期望 </${top || '?'}>，实际 </${name}>`,
        );
      }
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  if (stack.length) {
    throw new Error(`${file}: 存在未闭合标签 <${stack[stack.length - 1]}>`);
  }
  return cleaned;
}

/** 从 XML 里抽出所有属性值 */
function attrsOf(cleaned) {
  const attrs = [];
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    attrs.push({ name: m[1], value: m[2] });
  }
  return attrs;
}

// ─────────────────────────────────────────────
// 收集资源定义
// ─────────────────────────────────────────────

const defined = {
  string: new Map(),   // name -> 文件
  color: new Map(),
  dimen: new Map(),
  style: new Map(),
  drawable: new Map(),
  xml: new Map(),
  layout: new Map(),
  id: new Map(),
  mipmap: new Map(),
};

/** values/*.xml 里的 <string name="x">、<color name="x">、<style name="x">、<dimen name="x"> */
function collectValues() {
  const valuesDir = path.join(RES_DIR, 'values');
  if (!fs.existsSync(valuesDir)) return;

  for (const f of fs.readdirSync(valuesDir)) {
    if (!f.endsWith('.xml')) continue;
    const rel = `values/${f}`;
    const src = fs.readFileSync(path.join(valuesDir, f), 'utf8');
    let cleaned;
    try {
      cleaned = parseXml(src, rel);
    } catch (e) {
      bad(`XML 可解析：${rel}`, e.message);
      continue;
    }
    ok(`XML 可解析：${rel}`);

    // <string name="xxx">  —— 允许 name 前后有其他属性
    for (const m of cleaned.matchAll(/<string\s+[^>]*?name\s*=\s*"([^"]+)"/g)) {
      defined.string.set(m[1], rel);
    }
    for (const m of cleaned.matchAll(/<color\s+[^>]*?name\s*=\s*"([^"]+)"/g)) {
      defined.color.set(m[1], rel);
    }
    for (const m of cleaned.matchAll(/<dimen\s+[^>]*?name\s*=\s*"([^"]+)"/g)) {
      defined.dimen.set(m[1], rel);
    }
    for (const m of cleaned.matchAll(/<style\s+[^>]*?name\s*=\s*"([^"]+)"/g)) {
      defined.style.set(m[1], rel);
    }
  }
}

/** 目录里的文件即资源定义（drawable/layout/xml/mipmap） */
function collectFileResources() {
  const dirs = {
    drawable: 'drawable',
    layout: 'layout',
    xml: 'xml',
  };

  for (const [key, dir] of Object.entries(dirs)) {
    const full = path.join(RES_DIR, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.xml')) continue;
      const name = f.replace(/\.xml$/, '');
      defined[key].set(name, `${dir}/${f}`);
    }
  }

  // mipmap 分多个密度目录（mipmap-mdpi / -anydpi-v26 ...）：
  // 同一个资源名会在多个目录里各出现一份，这是**正常的**，
  // 只要任意一个密度目录里有定义即可。
  const mipmapDirs = fs.readdirSync(RES_DIR).filter((d) => d.startsWith('mipmap'));
  for (const dir of mipmapDirs) {
    const full = path.join(RES_DIR, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      // 允许 .xml 与 .png/.webp（真实项目常用 PNG 图标）
      const name = f.replace(/\.(xml|png|webp|jpg)$/i, '');
      if (!defined.mipmap.has(name)) {
        defined.mipmap.set(name, `${dir}/${f}`);
      }
    }
  }
}

/** 布局里的 @+id/xxx 即 id 资源 */
function collectIds() {
  const layoutDir = path.join(RES_DIR, 'layout');
  if (!fs.existsSync(layoutDir)) return;

  for (const f of fs.readdirSync(layoutDir)) {
    if (!f.endsWith('.xml')) continue;
    const src = fs.readFileSync(path.join(layoutDir, f), 'utf8');
    for (const m of src.matchAll(/@\+id\/([A-Za-z_]\w*)/g)) {
      defined.id.set(m[1], `layout/${f}`);
    }
  }

  // 菜单、导航等也可能定义 id，一并扫
  for (const sub of ['menu', 'navigation']) {
    const d = path.join(RES_DIR, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      const src = fs.readFileSync(path.join(d, f), 'utf8');
      for (const m of src.matchAll(/@\+id\/([A-Za-z_]\w*)/g)) {
        defined.id.set(m[1], `${sub}/${f}`);
      }
    }
  }
}

// ─────────────────────────────────────────────
// 收集引用
// ─────────────────────────────────────────────

/** @string/xxx 这类 XML 属性引用（含 ?attr/ 与 @android: 需排除） */
function collectXmlRefs() {
  const refs = [];
  const kinds = ['string', 'color', 'dimen', 'style', 'drawable', 'mipmap', 'xml', 'layout', 'id'];

  (function walk(dir, relBase) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      const rel = relBase ? `${relBase}/${f.name}` : f.name;
      if (f.isDirectory()) {
        walk(full, rel);
      } else if (f.name.endsWith('.xml')) {
        const src = fs.readFileSync(full, 'utf8');
        for (const kind of kinds) {
          // 只取本工程的引用；@android:xxx 是系统资源，跳过
          const re = new RegExp(`@${kind}\\/([A-Za-z_][\\w.]*)`, 'g');
          let m;
          while ((m = re.exec(src)) !== null) {
            // 形如 @string/abc 但被 @android:string/abc 命中的情况已由前缀排除
            refs.push({ kind, name: m[1], file: rel });
          }
        }
      }
    }
  })(RES_DIR, '');

  // AndroidManifest 也引用资源
  const manifest = path.join(APP, 'AndroidManifest.xml');
  if (fs.existsSync(manifest)) {
    const src = fs.readFileSync(manifest, 'utf8');
    for (const kind of kinds) {
      const re = new RegExp(`@${kind}\\/([A-Za-z_][\\w.]*)`, 'g');
      let m;
      while ((m = re.exec(src)) !== null) {
        refs.push({ kind, name: m[1], file: 'AndroidManifest.xml' });
      }
    }
  }

  return refs;
}

/** Kotlin 里 R.xxx.yyy 的引用 */
function collectKotlinRefs() {
  const refs = [];
  const kinds = ['string', 'color', 'dimen', 'style', 'drawable', 'mipmap', 'xml', 'layout', 'id'];

  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) {
        walk(full);
      } else if (f.name.endsWith('.kt')) {
        const src = fs.readFileSync(full, 'utf8');
        const rel = path.relative(JAVA_DIR, full).replace(/\\/g, '/');

        // R.string.xxx  或  com.canteen.scan.R.string.xxx
        for (const kind of kinds) {
          const re = new RegExp(`\\bR\\.${kind}\\.([A-Za-z_]\\w*)`, 'g');
          let m;
          while ((m = re.exec(src)) !== null) {
            refs.push({ kind, name: m[1], file: rel });
          }
        }
      }
    }
  })(JAVA_DIR);

  return refs;
}

// ─────────────────────────────────────────────
// 校验
// ─────────────────────────────────────────────

function checkXmlRefs() {
  const refs = collectXmlRefs();
  const missing = [];

  for (const r of refs) {
    // @id/xxx 可能是布局间互相引用（如 constraint 指向另一个 view），
    // 也可能由 @+id 定义在同文件；这里统一按 id 表判定
    if (!defined[r.kind].has(r.name)) {
      missing.push(`${r.file}: @${r.kind}/${r.name}`);
    }
  }

  if (missing.length === 0) {
    ok(`XML 资源引用全部有定义（共 ${refs.length} 处）`);
  } else {
    // 去重后逐条报，避免同一个缺失资源刷屏
    for (const m of [...new Set(missing)]) {
      bad('XML 引用了未定义的资源', m);
    }
  }
}

function checkKotlinRefs() {
  const refs = collectKotlinRefs();
  const missing = [];

  for (const r of refs) {
    if (!defined[r.kind].has(r.name)) {
      missing.push(`${r.file}: R.${r.kind}.${r.name}`);
    }
  }

  if (missing.length === 0) {
    ok(`Kotlin 资源引用全部有定义（共 ${refs.length} 处）`);
  } else {
    for (const m of [...new Set(missing)]) {
      bad('Kotlin 引用了未定义的资源', m);
    }
  }
}

/**
 * 校验带占位符的字符串在代码里使用时参数个数是否匹配。
 *
 * 这是**运行时**才会炸的错误（IllegalFormatException），
 * 而且往往在核销现场才被发现。静态查出来性价比很高。
 */
function checkStringFormatArgs() {
  // 1. 建立 name -> 占位符个数（取最大索引）
  const fmtCount = new Map();
  for (const [name, file] of defined.string) {
    const src = fs.readFileSync(path.join(RES_DIR, file), 'utf8');
    const re = new RegExp(`<string\\s+[^>]*?name\\s*=\\s*"${name}"[^>]*>([\\s\\S]*?)</string>`);
    const m = src.match(re);
    if (!m) continue;
    const body = m[1];
    const indices = [...body.matchAll(/%(\d+)\$/g)].map((x) => Number(x[1]));
    if (indices.length) {
      fmtCount.set(name, Math.max(...indices));
    }
  }

  if (fmtCount.size === 0) {
    ok('无需校验的格式化字符串');
    return;
  }

  // 2. 在 Kotlin 里找 getString(R.string.xxx, ...) / getString(R.string.xxx)
  //
  // 不能用简单正则 `getString\(...\)`：实参里经常带嵌套括号
  // （如 getString(R.string.x, formatYuan(meal))），正则的 [^)]*? 会在
  // 嵌套的 ')' 处提前截断，把参数个数数错 —— 第一版就因此产生了 10 个假阳性。
  // 正确做法：从 '(' 起做**平衡括号扫描**，顺带跳过字符串字面量，
  // 再按顶层逗号切分实参。
  let checked = 0;
  const mismatches = [];

  /**
   * 从 openParenIdx（指向 '('）扫描一个平衡的括号块，
   * 返回 { args: [顶层实参字符串], end: 块结束后第一个字符的下标 }。
   * 扫描中跳过 "..." 字面量（含 \" 转义），避免字面量里的括号干扰计数。
   */
  function scanBalancedCall(src, openParenIdx) {
    let depth = 0;
    let i = openParenIdx;
    const args = [];
    let buf = '';

    while (i < src.length) {
      const ch = src[i];

      if (ch === '"') {
        // 进入字符串字面量，整体跳过（处理转义）
        buf += ch;
        i++;
        while (i < src.length) {
          const c2 = src[i];
          buf += c2;
          if (c2 === '\\') {
            buf += src[i + 1] || '';
            i += 2;
            continue;
          }
          i++;
          if (c2 === '"') break;
        }
        continue;
      }

      if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
        // 最外层的 '(' 本身不进 buf —— 否则首参会变成 "(R.string.xxx"，
        // 后面的正则永远匹配不上（第二版调试时踩的坑）
        if (depth > 1) buf += ch;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) {
          // 调用结束；收尾最后一个实参（可能是空白/尾逗号后的空）
          const t = buf.trim();
          if (t.length) args.push(t);
          return { args, end: i + 1 };
        }
        buf += ch;
      } else if (ch === ',' && depth === 1) {
        args.push(buf.trim());
        buf = '';
      } else {
        buf += ch;
      }
      i++;
    }

    // 括号不平衡（不该发生）—— 返回已收集内容，end 指向末尾避免死循环
    const t = buf.trim();
    if (t.length) args.push(t);
    return { args, end: src.length };
  }

  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) {
        walk(full);
      } else if (f.name.endsWith('.kt')) {
        const src = fs.readFileSync(full, 'utf8');
        const rel = path.relative(JAVA_DIR, full).replace(/\\/g, '/');

        let idx = src.indexOf('getString(');
        while (idx !== -1) {
          // 排除诸如 myGetString( 的误命中：前一个字符不能是标识符字符
          const prev = idx > 0 ? src[idx - 1] : '';
          if (!/[A-Za-z0-9_]/.test(prev)) {
            const { args, end } = scanBalancedCall(src, idx + 'getString('.length - 1);
            // 首参应是 R.string.xxx（允许 com.xxx.R.string.xxx 全限定写法）
            const first = (args[0] || '').replace(/\s+/g, '');
            const m = first.match(/^(?:[\w.]*\.)?R\.string\.(\w+)$/);
            if (m) {
              const name = m[1];
              const expected = fmtCount.get(name);
              if (expected !== undefined) {
                checked++;
                const actual = args.length - 1;
                if (actual !== expected) {
                  mismatches.push(
                    `${rel}: R.string.${name} 需要 ${expected} 个参数，实际传了 ${actual} 个`,
                  );
                }
              }
            }
            idx = src.indexOf('getString(', end);
          } else {
            idx = src.indexOf('getString(', idx + 1);
          }
        }
      }
    }
  })(JAVA_DIR);

  if (mismatches.length === 0) {
    ok(`格式化字符串参数个数匹配（检查了 ${checked} 处调用）`);
  } else {
    for (const m of mismatches) bad('格式化字符串参数个数不匹配', m);
  }
}

/** Manifest 里声明的 Activity 必须有对应 Kotlin 文件 */
function checkManifestActivities() {
  const manifest = path.join(APP, 'AndroidManifest.xml');
  if (!fs.existsSync(manifest)) {
    bad('AndroidManifest.xml 存在');
    return;
  }

  const src = fs.readFileSync(manifest, 'utf8');
  const activities = [...src.matchAll(/android:name\s*=\s*"\.([A-Za-z_][\w.]*)"/g)]
    .map((m) => m[1])
    // application 的 name=".ScanApp" 也会被匹配到，用是否有 Activity 标签区分
    .filter((n) => !['ScanApp'].includes(n));

  const missing = [];
  for (const cls of activities) {
    const parts = cls.split('.');
    const file = path.join(JAVA_DIR, 'com', 'canteen', 'scan', ...parts.slice(0, -1), parts[parts.length - 1] + '.kt');
    if (!fs.existsSync(file)) missing.push(cls);
  }

  if (missing.length === 0) {
    ok(`Manifest 声明的 ${activities.length} 个组件均有对应文件`);
  } else {
    for (const m of missing) bad('Manifest 声明的组件缺少 Kotlin 文件', m);
  }
}

/**
 * ViewBinding：布局 activity_scan.xml → ActivityScanBinding。
 * 代码里引用了某个 Binding 类，就必须有同名布局。
 */
function checkViewBinding() {
  const srcs = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else if (f.name.endsWith('.kt')) srcs.push(full);
    }
  })(JAVA_DIR);

  const missing = [];
  let found = 0;

  for (const full of srcs) {
    const src = fs.readFileSync(full, 'utf8');
    const rel = path.relative(JAVA_DIR, full).replace(/\\/g, '/');

    for (const m of src.matchAll(/\b([A-Z]\w*Binding)\b/g)) {
      const bindingName = m[1];
      if (bindingName === 'ViewBinding') continue;

      // ActivityScanBinding -> activity_scan
      const snake = bindingName
        .replace(/Binding$/, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase();

      const layoutFile = path.join(RES_DIR, 'layout', snake + '.xml');
      found++;
      if (!fs.existsSync(layoutFile)) {
        missing.push(`${rel}: ${bindingName} 需要 layout/${snake}.xml`);
      }
    }
  }

  if (missing.length === 0) {
    ok(`ViewBinding 对应布局齐全（检查了 ${found} 处）`);
  } else {
    for (const m of [...new Set(missing)]) bad('ViewBinding 缺少对应布局', m);
  }
}

/** Kotlin 源文件数与关键类存在性 —— 防止漏写文件 */
function checkRequiredClasses() {
  const required = [
    'com/canteen/scan/ScanApp.kt',
    'com/canteen/scan/data/DeviceStore.kt',
    'com/canteen/scan/data/HistoryStore.kt',
    'com/canteen/scan/net/ApiClient.kt',
    'com/canteen/scan/net/ApiResponse.kt',
    'com/canteen/scan/net/VerifyModels.kt',
    'com/canteen/scan/scan/Haptics.kt',
    'com/canteen/scan/scan/QrAnalyzer.kt',
    'com/canteen/scan/scan/Speaker.kt',
    'com/canteen/scan/ui/BindActivity.kt',
    'com/canteen/scan/ui/HistoryActivity.kt',
    'com/canteen/scan/ui/ResultActivity.kt',
    'com/canteen/scan/ui/ScanActivity.kt',
    'com/canteen/scan/ui/SplashActivity.kt',
  ];

  const missing = required.filter((r) => !fs.existsSync(path.join(JAVA_DIR, r)));
  if (missing.length === 0) {
    ok(`关键类文件齐全（${required.length} 个）`);
  } else {
    for (const m of missing) bad('缺少关键类文件', m);
  }
}

/**
 * 校验 Kotlin 里的包声明与目录结构一致。
 * 包名错了编译器直接报错，但这是"读一眼就能查出"的错误，
 * 没必要留给用户去发现。
 */
function checkPackageDeclarations() {
  const mismatches = [];

  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) {
        walk(full);
      } else if (f.name.endsWith('.kt')) {
        const src = fs.readFileSync(full, 'utf8');
        const rel = path.relative(JAVA_DIR, full).replace(/\\/g, '/');
        const expectedPkg = rel
          .split('/')
          .slice(0, -1)
          .join('.');
        const m = src.match(/^package\s+([\w.]+)/m);
        if (!m) {
          mismatches.push(`${rel}: 缺少 package 声明`);
        } else if (m[1] !== expectedPkg) {
          mismatches.push(`${rel}: 声明为 ${m[1]}，按目录应为 ${expectedPkg}`);
        }
      }
    }
  })(JAVA_DIR);

  if (mismatches.length === 0) {
    ok('Kotlin 包声明与目录结构一致');
  } else {
    for (const m of mismatches) bad('包声明不匹配', m);
  }
}

/** 所有布局 XML 必须能解析 */
function checkAllXml() {
  let count = 0;
  const broken = [];

  (function walk(dir, relBase) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      const rel = relBase ? `${relBase}/${f.name}` : f.name;
      if (f.isDirectory()) {
        walk(full, rel);
      } else if (f.name.endsWith('.xml')) {
        const src = fs.readFileSync(full, 'utf8');
        try {
          parseXml(src, rel);
          count++;
        } catch (e) {
          broken.push(e.message);
        }
      }
    }
  })(RES_DIR, '');

  // values/ 已在 collectValues 里检查过，这里只报新增问题
  const newlyBroken = broken.filter(
    (b) => !b.startsWith('values/'),
  );
  if (newlyBroken.length === 0) {
    ok(`资源 XML 全部可解析（${count} 个文件）`);
  } else {
    for (const b of newlyBroken) bad('XML 解析失败', b);
  }

  checkXmlNamespaces();
}

/**
 * 校验 XML 里使用的命名空间前缀都已声明。
 *
 * 背景：activity_bind.xml 曾用了 tools:text 却漏声明 xmlns:tools，
 * AAPT2 编译会直接报 "unbound prefix" —— 属于编译级错误。
 * 本脚本的标签栈解析器不校验命名空间，第一版因此漏掉了它（审计时人工发现）。
 * 规则：每个带前缀的属性（android:xxx / app:xxx / tools:xxx），
 * 其前缀必须在同一文件里有 xmlns:前缀= 声明。
 */
function checkXmlNamespaces() {
  const files = [];
  (function walk(dir, relBase) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      const rel = relBase ? `${relBase}/${f.name}` : f.name;
      if (f.isDirectory()) walk(full, rel);
      else if (f.name.endsWith('.xml')) files.push({ full, rel });
    }
  })(RES_DIR, '');
  files.push({ full: path.join(APP, 'AndroidManifest.xml'), rel: 'AndroidManifest.xml' });

  const badPrefixes = [];
  for (const { full, rel } of files) {
    // 去掉注释与处理指令，避免注释里的示例代码干扰前缀收集
    const cleaned = fs.readFileSync(full, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\?[\s\S]*?\?>/g, '');

    const declared = new Set();
    for (const m of cleaned.matchAll(/xmlns:([A-Za-z_][\w.-]*)\s*=/g)) {
      declared.add(m[1]);
    }

    // (?!xmlns:) 排除声明本身；(?:^|\s) 保证匹配的是属性名起始
    for (const m of cleaned.matchAll(
      /(?:^|\s)(?!xmlns:)([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*\s*=/g,
    )) {
      if (!declared.has(m[1])) {
        badPrefixes.push(`${rel}: 使用了未声明的命名空间前缀 "${m[1]}:"`);
      }
    }
  }

  if (badPrefixes.length === 0) {
    ok(`XML 命名空间前缀均已声明（${files.length} 个文件）`);
  } else {
    for (const b of [...new Set(badPrefixes)]) bad('XML 命名空间前缀未声明', b);
  }
}

// ─────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────

function main() {
  console.log('\n═══ 安卓工程静态一致性检查 ═══');
  console.log('（本机无 Android SDK，无法编译；本检查只覆盖可静态判定的引用问题）');

  if (!fs.existsSync(JAVA_DIR)) {
    console.error(`\n找不到源码目录：${JAVA_DIR}`);
    process.exit(1);
  }

  section('1. 资源定义收集');
  collectValues();
  collectFileResources();
  collectIds();
  ok(
    `已收集：string ${defined.string.size} / color ${defined.color.size} / ` +
      `dimen ${defined.dimen.size} / style ${defined.style.size} / ` +
      `drawable ${defined.drawable.size} / layout ${defined.layout.size} / ` +
      `xml ${defined.xml.size} / mipmap ${defined.mipmap.size} / id ${defined.id.size}`,
  );

  section('2. XML 可解析性');
  checkAllXml();

  section('3. XML 资源引用');
  checkXmlRefs();

  section('4. Kotlin 资源引用');
  checkKotlinRefs();

  section('5. 格式化字符串参数');
  checkStringFormatArgs();

  section('6. Manifest 与组件');
  checkManifestActivities();

  section('7. ViewBinding 与布局');
  checkViewBinding();

  section('8. 工程完整性');
  checkRequiredClasses();
  checkPackageDeclarations();

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
