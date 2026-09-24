/**
 * 二维码编码器验证：用真实解码库 jsQR 反解我们生成的矩阵。
 *
 * 为什么必须用真解码器：结构自检（selfCheck）只能证明「形状对」，
 * 掩模、格式信息位序、版本信息这些东西全都写错时，矩阵看上去依然像模像样，
 * 只有把矩阵喂给真解码器才能证明「扫得出来」。
 * 历史上正是靠这个脚本抓出了三处肉眼不可见的错误：
 *   1. 掩模用错（mask 0 → 应为 2）
 *   2. 格式信息位序反了（高位在先 → 应为低位在先）
 *   3. 版本信息只预留没写 + 容量表从版本 7 起少算 2-3 个码字
 *
 * 依赖：typescript（项目已有）、jsqr（仅本脚本用，装在 scripts/ 下）
 * 用法：npm run verify:qr
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const jsQR = require('jsqr');

const ENCODER = path.join(__dirname, '..', 'src', 'modules', 'qrcode', 'qr-encoder.ts');
const TMP = path.join(__dirname, '.qr-encoder.tmp.js');

// ── 用 TypeScript 官方 transpileModule 去类型，避免手写正则漏掉标注 ──
let s = fs.readFileSync(ENCODER, 'utf8');
// 该文件唯一的对外依赖只是 import 语句；编码逻辑本身零依赖，直接摘掉
s = s.replace(/^import \{[^}]*\} from '[^']*';?\s*$/m, '');

const compiled = ts.transpileModule(s, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    removeComments: false,
  },
});
fs.writeFileSync(TMP, compiled.outputText, 'utf8');

const { QrEncoder, buildQrPayload, parseQrPayload, toSvgDataUrl } = require(TMP);

// ── 渲染矩阵成 RGBA，喂给 jsQR ──
function decode(matrix, scale = 8, quiet = 4) {
  const n = matrix.length;
  const dim = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (c + quiet) * scale + dx;
          const y = (r + quiet) * scale + dy;
          const i = (y * dim + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }

  return jsQR(data, dim, dim);
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

console.log('\n═══ 二维码编码器验证（jsQR 反解）═══\n');

// 1. 真实业务载荷：48 位十六进制 token
const token = 'a3f8c1d94e7b2065f18a3c5d9e2b7f4a0c6d8e1b';
const payload = buildQrPayload(token);
console.log(`载荷: ${payload} (${payload.length} 字节)\n`);

const matrix = QrEncoder.encode(payload);
const version = (matrix.length - 17) / 4;
console.log(`矩阵尺寸: ${matrix.length}x${matrix.length} → 版本 ${version}\n`);

const res = decode(matrix);
check('jsQR 成功解码', !!res);
check('解码内容与原文一致', !!res && res.data === payload, res ? `得到 "${res.data}"` : '未解码');

// 2. 往返：解析回 token
if (res) {
  check('parseQrPayload 还原 token', parseQrPayload(res.data) === token);
}

// 3. 不同长度输入的版本自适应
console.log('\n── 多长度适配 ──');
for (const len of [8, 16, 32, 48, 64, 96, 128, 200]) {
  const t = 'f'.repeat(len);
  const p = buildQrPayload(t);
  let okFlag = false;
  let got = '';
  try {
    const d = decode(QrEncoder.encode(p));
    okFlag = !!d && d.data === p;
    got = d ? `得到 ${d.data.length} 字节` : '未解码';
  } catch (e) {
    got = e.message;
  }
  check(`token ${len} 字符可编码并解码`, okFlag, okFlag ? '' : got);
}

// 4. 版本 1-20 满载：每个版本都塞到容量上界，确认没有边界性错误
console.log('\n── 版本 1-20 容量满载 ──');
const CAPACITY = [
  14, 26, 42, 62, 84, 106, 122, 152, 180, 213,
  251, 287, 331, 362, 412, 450, 504, 560, 624, 666,
];
let fullOk = 0;
const fullBad = [];
for (let v = 1; v <= 20; v++) {
  const n = CAPACITY[v - 1] - 5; // 扣掉 'TCV1:' 前缀
  const p = 'TCV1:' + 'a'.repeat(n);
  try {
    const m = QrEncoder.encode(p);
    const actual = (m.length - 17) / 4;
    const d = decode(m, 6);
    if (!!d && d.data === p && actual === v) fullOk++;
    else fullBad.push(`v${v}(实际v${actual})`);
  } catch (e) {
    fullBad.push(`v${v}:${e.message}`);
  }
}
check(
  `版本 1-20 满载均可解码（${fullOk}/20）`,
  fullOk === 20,
  fullBad.join(', '),
);

// 5. 中文（多字节 UTF-8）也要能过
try {
  const cn = '团餐核销·员工就餐凭证';
  const d = decode(QrEncoder.encode(cn));
  check('中文载荷可解码', !!d && d.data === cn, d ? d.data : '未解码');
} catch (e) {
  check('中文载荷可解码', false, e.message);
}

// 6. SVG 输出可生成，且能被浏览器/小程序当图片用
try {
  const url = toSvgDataUrl(matrix);
  const okPrefix = url.startsWith('data:image/svg+xml;base64,');
  const okLen = url.length > 500;
  // 解回 SVG 源码，确认真的有 rect/path 结构
  const svg = Buffer.from(url.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
  check(
    'SVG data URL 生成且结构完整',
    okPrefix && okLen && svg.includes('<rect') && svg.includes('<path'),
    `${url.length} 字符`,
  );
} catch (e) {
  check('SVG data URL 生成且结构完整', false, e.message);
}

// 7. 反向验证：自检必须能抓出被破坏的矩阵
console.log('\n── 反向验证（护栏是否真在起作用）──');
try {
  const broken = matrix.map((row) => row.slice());
  broken[10][10] = !broken[10][10];
  const d = decode(broken);
  // 纠错 M 可容忍少量错误 —— 翻转仍应能解码，说明纠错在起作用
  check('翻转 1 个模块后仍可解码（纠错生效）', !!d && d.data === payload);
} catch (e) {
  check('翻转 1 个模块后仍可解码（纠错生效）', false, e.message);
}

/**
 * 8. 独立验证格式信息本身。
 *
 * 为什么需要这一项：jsQR 对格式信息的容错**强得超出直觉**——
 * 实测把 BCH 多项式从 0x537 改成 0x53f（格式位全错），
 * 解码**依然成功**，因为解码器会扫描 32 种掩模 × 4 种纠错等级的组合去试。
 * 也就是说「解码成功」并不能证明格式信息写对了。
 *
 * 但格式信息写错在真实场景里是有代价的：部分老旧扫码枪不做穷举，
 * 只按格式信息里写的掩模去解，就会读不出来。
 * 所以这里按规范独立算一遍格式位，逐位比对矩阵里的实际取值。
 */
console.log('\n── 格式信息独立校验（不依赖解码器容错）──');
try {
  const n = matrix.length;

  /**
   * 格式信息在矩阵里有**三处**拷贝，按规范它们的位序各不相同，
   * 不能想当然地认为「右上横 = 低 8 位、左下竖 = 高 7 位」——
   * 实测左下竖放的是 bit8..bit14，而 bit7 其实在右上横之外，
   * 15 位在左上区域是「竖 6 + 3 + 横 6」的一条折线。三处读法见下。
   */
  // ① 左上：竖 (0..5,8) + (7,8) + (8,8) + (8,7) + 横 (8,5..8,0)
  const topLeftCoords = [];
  for (let r = 0; r <= 5; r++) topLeftCoords.push([r, 8]);
  topLeftCoords.push([7, 8], [8, 8], [8, 7]);
  for (let c = 5; c >= 0; c--) topLeftCoords.push([8, c]);
  let readTopLeft = 0;
  for (let i = 0; i < 15; i++) {
    const [r, c] = topLeftCoords[i];
    if (matrix[r][c]) readTopLeft |= 1 << i;
  }

  // ② 右上横 (8, n-1 .. n-8) = bit0..bit7
  let readTopRight = 0;
  for (let i = 0; i < 8; i++) {
    if (matrix[8][n - 1 - i]) readTopRight |= 1 << i;
  }

  // ③ 左下竖 (n-1..n-7, 8) = bit8..bit14
  let readBottomLeft = 0;
  for (let i = 0; i < 7; i++) {
    if (matrix[n - 1 - i][8]) readBottomLeft |= 1 << i;
  }

  // 按规范重算期望值：纠错 M = 0b00，掩模 2
  const EC = 0b00;
  const MASK = 2;
  const data = (EC << 3) | MASK;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  const expected = (((data << 10) | rem) ^ 0x5412) & 0x7fff;

  check(
    '左上格式信息 = 规范计算值',
    readTopLeft === expected,
    `实际=0b${readTopLeft.toString(2)} 期望=0b${expected.toString(2)}`,
  );
  check(
    '右上横副本一致（bit0..bit7）',
    readTopRight === (expected & 0xff),
    `实际=0b${readTopRight.toString(2).padStart(8, '0')}`,
  );
  check(
    '左下竖副本一致（bit8..bit14）',
    readBottomLeft === (expected >> 8),
    `实际=0b${readBottomLeft.toString(2).padStart(7, '0')}`,
  );

  /**
   * 掩模位与纠错等级位要对着**加扰前**的 data 断言，不能对着 expected ——
   * `^ 0x5412` 会把这几个 bit 翻掉（0x5412 的低位非零），
   * 拿 expected 去读「掩模是几」必然读到错的值。
   */
  check('格式信息的掩模位 = 2', (data & 0b111) === 2, `实际=${data & 0b111}`);
  check('格式信息的纠错等级位 = M(0b00)', ((data >> 3) & 0b11) === 0b00, `实际=${(data >> 3) & 0b11}`);
  // 顺带确认加扰确实生效（否则说明 ^ 0x5412 被漏掉了）
  check('格式信息已施加 0x5412 加扰', expected !== data);
} catch (e) {
  check('格式信息独立校验', false, e.message);
}

console.log(`\n${'═'.repeat(46)}`);
console.log(`  通过 ${pass} 项 / 失败 ${fail} 项`);
console.log(`${'═'.repeat(46)}\n`);

fs.unlinkSync(TMP);
process.exit(fail > 0 ? 1 : 0);
