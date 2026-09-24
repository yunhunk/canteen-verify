/**
 * 静态 Schema 护栏：比对 sql/init.sql 与 TypeORM 实体
 *
 * 拦截的是「建表脚本与实体漂移」这类错误 —— 它们不会在开发时报错
 * （本地用 synchronize 或另一个库），只会在生产部署时爆炸。
 *
 * 校验项：表集合、每张表的列集合、唯一约束。
 *
 * 用法：node scripts/check-schema.js（或在 backend/ 下 npm run check:schema）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SQL_FILE = path.join(ROOT, 'sql', 'init.sql');
const ENTITY_DIR = path.join(ROOT, 'src', 'database', 'entities');

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
// 1. 解析 init.sql
// ─────────────────────────────────────────────

function parseSql(sql) {
  const tables = new Map();

  // 去掉注释行，避免注释里的反引号干扰
  const clean = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(([\s\S]*?)\n\)\s*ENGINE/gi;

  let m;
  while ((m = tableRe.exec(clean)) !== null) {
    const tableName = m[1];
    const body = m[2];

    const columns = new Set();
    const uniques = new Set();

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line) continue;

      // 列定义
      const colMatch = line.match(/^`(\w+)`\s+([A-Za-z]+)/);
      if (colMatch) {
        columns.add(colMatch[1]);
        continue;
      }

      // 唯一约束
      const ukMatch = line.match(/^UNIQUE\s+KEY\s+`(\w+)`\s*\(([^)]+)\)/i);
      if (ukMatch) {
        const cols = ukMatch[2]
          .split(',')
          .map((c) => c.trim().replace(/`/g, ''))
          .filter((c) => /^\w+$/.test(c))
          .sort()
          .join(',');
        uniques.add(`${ukMatch[1]}(${cols})`);
        continue;
      }

      // 主键
      const pkMatch = line.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i);
      if (pkMatch) {
        columns.add(pkMatch[1].trim().replace(/`/g, '').split(/\s+/)[0]);
        continue;
      }
    }

    tables.set(tableName, { columns, uniques });
  }

  return tables;
}

// ─────────────────────────────────────────────
// 2. 解析 TypeORM 实体
// ─────────────────────────────────────────────

const COLUMN_DECORATOR_RE = /@(?:PrimaryGeneratedColumn|PrimaryColumn|Column|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|VersionColumn)\s*\(/;

/** 从装饰器括号内提取嵌套括号平衡的完整参数串 */
function extractDecoratorArgs(src, startIdx) {
  let depth = 0;
  let i = startIdx;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(startIdx + 1, i);
    }
  }
  return '';
}

function parseEntities(entityDir) {
  const entities = new Map();
  const files = fs.readdirSync(entityDir).filter((f) => f.endsWith('.entity.ts'));

  for (const file of files) {
    const src = fs.readFileSync(path.join(entityDir, file), 'utf8');

    // 表名
    const entityMatch = src.match(/@Entity\(\s*['"`](\w+)['"`]/);
    if (!entityMatch) continue;
    const tableName = entityMatch[1];

    // 类体范围：从 class 声明到文件末尾的最后一个 } 之前
    const classIdx = src.search(/export\s+class\s+\w+/);
    if (classIdx === -1) continue;
    const classBody = src.slice(classIdx);

    const columns = new Set();
    const uniques = new Set();

    // 逐行扫描：装饰器可能跨行，用索引方式定位更稳
    const decoratorRe = new RegExp(
      '@(PrimaryGeneratedColumn|PrimaryColumn|Column|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|VersionColumn)\\s*\\(',
      'g',
    );

    let dm;
    while ((dm = decoratorRe.exec(classBody)) !== null) {
      const argsStart = dm.index + dm[0].length - 1;
      const args = extractDecoratorArgs(classBody, argsStart);

      // 装饰器后面第一个属性名
      const afterIdx = argsStart + args.length + 1;
      const propMatch = classBody.slice(afterIdx).match(/^\s*(?:public\s+|readonly\s+)*(\w+)\s*[!?]?\s*:/m);
      if (!propMatch) continue;
      const propName = propMatch[1];

      // { name: 'xxx' } 显式指定列名，否则用属性名
      const nameMatch = args.match(/name\s*:\s*['"`](\w+)['"`]/);
      const columnName = nameMatch ? nameMatch[1] : propName;

      columns.add(columnName);
    }

    // @Index('uk_xxx', ['a','b'], { unique: true })
    const indexRe = /@Index\(\s*['"`](\w+)['"`]\s*,\s*\[([^\]]+)\]\s*,\s*\{\s*unique\s*:\s*true\s*\}/g;
    let im;
    while ((im = indexRe.exec(src)) !== null) {
      const idxName = im[1];
      // 数组元素是属性名，需要映射回列名
      const props = im[2]
        .split(',')
        .map((p) => p.trim().replace(/['"`]/g, ''))
        .filter(Boolean);

      const cols = props.map((p) => mapPropToColumn(classBody, p)).sort().join(',');
      uniques.add(`${idxName}(${cols})`);
    }

    entities.set(tableName, { columns, uniques });
  }

  return entities;
}

/** 把实体属性名映射为列名（考虑 @Column({ name: 'x' })） */
function mapPropToColumn(classBody, prop) {
  const propRe = new RegExp(`@(?:Column|PrimaryGeneratedColumn|CreateDateColumn|UpdateDateColumn)\\s*\\(([\\s\\S]*?)\\)\\s*(?:public\\s+|readonly\\s+)*${prop}\\s*[!?]?\\s*:`, 'm');
  const m = classBody.match(propRe);
  if (m) {
    const nameMatch = m[1].match(/name\s*:\s*['"`](\w+)['"`]/);
    if (nameMatch) return nameMatch[1];
  }
  return prop;
}

// ─────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────

function main() {
  console.log('\n═══ Schema 漂移检查（init.sql ↔ TypeORM 实体）═══');

  if (!fs.existsSync(SQL_FILE)) {
    console.error(`找不到 ${SQL_FILE}`);
    process.exit(1);
  }

  const sqlTables = parseSql(fs.readFileSync(SQL_FILE, 'utf8'));
  const entityTables = parseEntities(ENTITY_DIR);

  section('1. 表集合');
  const sqlNames = [...sqlTables.keys()].sort();
  const entNames = [...entityTables.keys()].sort();

  ok(`init.sql 解析出 ${sqlNames.length} 张表：${sqlNames.join(', ')}`);
  ok(`实体解析出 ${entNames.length} 张表：${entNames.join(', ')}`);

  const onlySql = sqlNames.filter((t) => !entNames.includes(t));
  const onlyEnt = entNames.filter((t) => !sqlNames.includes(t));

  if (onlySql.length === 0 && onlyEnt.length === 0) {
    ok('表集合完全一致');
  } else {
    if (onlySql.length) bad('以下表只存在于 init.sql', onlySql.join(', '));
    if (onlyEnt.length) bad('以下表只存在于实体（未建表）', onlyEnt.join(', '));
  }

  if (sqlNames.length !== 11) {
    bad(`表数量应为 11，实际 ${sqlNames.length}`);
  } else {
    ok('表数量为 11 张（与设计文档一致）');
  }

  section('2. 逐表列比对');
  for (const table of sqlNames) {
    const sqlCols = sqlTables.get(table)?.columns;
    const entCols = entityTables.get(table)?.columns;
    if (!sqlCols || !entCols) continue;

    const missingInEntity = [...sqlCols].filter((c) => !entCols.has(c));
    const missingInSql = [...entCols].filter((c) => !sqlCols.has(c));

    if (missingInEntity.length === 0 && missingInSql.length === 0) {
      ok(`${table}：${sqlCols.size} 列一致`);
    } else {
      bad(
        `${table}：列不一致`,
        [
          missingInEntity.length ? `实体缺列 [${missingInEntity.join(', ')}]` : '',
          missingInSql.length ? `建表脚本缺列 [${missingInSql.join(', ')}]` : '',
        ]
          .filter(Boolean)
          .join('；'),
      );
    }
  }

  section('3. 唯一约束比对');
  for (const table of sqlNames) {
    const sqlUk = sqlTables.get(table)?.uniques;
    const entUk = entityTables.get(table)?.uniques;
    if (!sqlUk || !entUk) continue;

    // 只比对两侧都声明了唯一约束的情况；实体侧的 @Index 命名可能与 SQL 不同
    const sqlColSets = [...sqlUk].map((u) => u.replace(/^\w+\(/, '').replace(/\)$/, ''));
    const entColSets = [...entUk].map((u) => u.replace(/^\w+\(/, '').replace(/\)$/, ''));

    const onlySql = sqlColSets.filter((c) => !entColSets.includes(c));
    const onlyEnt = entColSets.filter((c) => !sqlColSets.includes(c));

    if (onlySql.length === 0 && onlyEnt.length === 0) {
      ok(`${table}：唯一约束一致${sqlUk.size ? ` (${sqlUk.size} 个)` : ''}`);
    } else {
      bad(
        `${table}：唯一约束不一致`,
        [
          onlySql.length ? `仅 SQL 有 [${onlySql.join(' | ')}]` : '',
          onlyEnt.length ? `仅实体有 [${onlyEnt.join(' | ')}]` : '',
        ]
          .filter(Boolean)
          .join('；'),
      );
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
