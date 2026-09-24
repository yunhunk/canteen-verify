import { APP_CONFIG, AppConfig } from '../../config/app.config';

/**
 * 掩模图案与纠错等级 —— 这两个值由「与参考实现逐格比对」实测确定，
 * 不是随手挑的。改动任一个都会让二维码扫不出来，改前请先跑
 * `npm run verify:qr`（用真实解码器反解，不是结构自检）。
 */
const MASK_PATTERN = 2;
/** 格式信息里的纠错等级位：M = 0b00 */
const EC_LEVEL_BITS = 0b00;

const CHAR_COUNT_TABLE = [
  // 版本 1-40 的字符数指示符位数（数字模式不适用），这里用字节模式
  // 索引 = 版本号，值 = 字符数指示符比特数
  -1, 8, 8, 8, 8, 8, 8, 8, 8, 8, // 1-9
  16, 16, 16, 16, 16, 16, 16, 16, 16, 16, // 10-19
  16, 16, 16, 16, 16, 16, 16, 16, 16, 16, // 20-29
  16, 16, 16, 16, 16, 16, 16, 16, 16, 16, // 30-39
  16, // 40
];

/** 各版本的对齐图案中心坐标（版本 1 无对齐图案） */
const ALIGNMENT_PATTERN_TABLE = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
];

/**
 * 版本 1-20 在纠错等级 M 下的分块参数（ISO/IEC 18004 表 13-22）。
 *
 * 每项 = [第一组块数, 第一组每块数据码字数, 第二组块数, 第二组每块数据码字数, 每块纠错码字数]
 * 第二组为 0 表示只有一个组。**这是权威表，不要用公式反推**——
 * 早期版本用「模块总数减去功能图案」估算总码字数，从版本 7 起每版少算 2-3 个码字，
 * 导致 133 字节的载荷被错判成装得进版本 8，随后数据被静默截断、码扫不出来。
 */
const EC_BLOCKS_M: ReadonlyArray<readonly [number, number, number, number, number]> = [
  // 版本 1-10
  [1, 16, 0, 0, 10], [1, 28, 0, 0, 16], [1, 44, 0, 0, 26], [2, 32, 0, 0, 18],
  [2, 43, 0, 0, 24], [4, 27, 0, 0, 16], [4, 31, 0, 0, 18], [2, 38, 2, 39, 22],
  [3, 36, 2, 37, 22], [4, 43, 1, 44, 26],
  // 版本 11-20
  [1, 50, 4, 51, 30], [6, 36, 2, 37, 22], [8, 37, 1, 38, 22], [4, 40, 5, 41, 24],
  [5, 41, 5, 42, 24], [7, 45, 3, 46, 28], [10, 46, 1, 47, 28], [9, 43, 4, 44, 26],
  [3, 44, 11, 45, 26], [3, 41, 13, 42, 26],
];

/**
 * 纯 JS 的二维码编码器（字节模式 + 纠错等级 M）。
 *
 * 为什么手写而不是装 `qrcode` 包：
 * 后端被限制在**零依赖本地模式**运行（LOCAL_MODE=1 时连 MySQL/Redis 都不要），
 * 二维码是核销链路的必需品而不是可选装饰，不该因为依赖装不上就整个功能不可用。
 * 这里只实现 byte 模式 + 纠错 M —— 覆盖 token 是 48 位十六进制这一种输入，
 * 不做多模式/多纠错等级，代码量可控且没有未测试分支。
 *
 * ⚠️ 核心校验：`selfCheck()` 必须通过，否则宁可报错也不能输出错码 ——
 * 一个画错的二维码会让员工在窗口前干等，比明确的报错糟糕得多。
 */
export class QrEncoder {
  private readonly size: number;
  private readonly modules: boolean[][];
  private readonly reserved: boolean[][];

  constructor(
    private readonly text: string,
    private version: number,
  ) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  /** 自动选一个装得下的最小版本 */
  static encode(text: string): boolean[][] {
    const data = Buffer.from(text, 'utf8');

    for (let version = 1; version <= 20; version++) {
      const capacity = QrEncoder.dataCapacityBytes(version);
      if (data.length <= capacity) {
        const enc = new QrEncoder(text, version);
        enc.build();
        enc.selfCheck();
        return enc.modules;
      }
    }
    throw new Error(`内容过长，无法编码：${data.length} 字节`);
  }

  /** 给定版本在纠错等级 M 下的可容纳字节数 */
  private static dataCapacityBytes(version: number): number {
    const { dataCodewords } = QrEncoder.blockStructure(version);
    const ccBits = CHAR_COUNT_TABLE[version] ?? 16;
    // 4 位模式指示符 + ccBits 字符数 + 数据 + 最多 4 位填充
    const usableBits = dataCodewords * 8 - 4 - ccBits;
    return Math.floor(usableBits / 8);
  }

  /**
   * 把一个版本的数据码字按 M 纠错的分块表切开。
   *
   * 全部来自 `EC_BLOCKS_M`，不做任何估算 —— 总码字数、数据码字数、
   * 纠错码字数、分块方式四者必须自洽，一旦某处用公式近似，
   * 高版本就会漂移出 2-3 个码字，表现为「版本选小 → 数据截断 → 扫不出来」。
   */
  private static blockStructure(version: number): {
    dataCodewords: number;
    ecCodewords: number;
    totalCodewords: number;
    groups: Array<{ count: number; dataPerBlock: number }>;
    ecPerBlock: number;
  } {
    const row = EC_BLOCKS_M[version - 1];
    if (!row) throw new Error(`不支持版本 ${version}（仅支持 1-20）`);
    const [g1Count, g1Data, g2Count, g2Data, ecPerBlock] = row;

    const groups = [{ count: g1Count, dataPerBlock: g1Data }];
    if (g2Count > 0) groups.push({ count: g2Count, dataPerBlock: g2Data });

    const dataCodewords = groups.reduce((sum, g) => sum + g.count * g.dataPerBlock, 0);
    const blockCount = groups.reduce((sum, g) => sum + g.count, 0);
    const ecCodewords = ecPerBlock * blockCount;

    return {
      dataCodewords,
      ecCodewords,
      totalCodewords: dataCodewords + ecCodewords,
      groups,
      ecPerBlock,
    };
  }

  private build(): void {
    this.drawFinderPatterns();
    this.drawAlignmentPatterns();
    // 版本信息区必须在定时图案之前占位：它与定时图案在第 8 列/行有交叠，
    // 先占位才能让定时图案绕过它（见 drawTimingPatterns）。
    if (this.version >= 7) this.reserveVersionAreas();
    this.drawTimingPatterns();
    this.reserveFormatAreas();

    const bits = this.buildDataBits();
    const codewords = this.bitsToCodewords(bits);
    const finalCodewords = this.addErrorCorrection(codewords);

    this.placeData(finalCodewords);
    this.writeVersionInfo();
    this.applyMaskAndFormat();
  }
  /** 画三个定位图案。
   *
   * 关键：**分隔符必须保持白色**。
   * 定位图案本体是 7x7，外面还要留一圈白（separator），占 8x8。
   * 早期版本从 -1 循环到 7 并把自己算出来的"环"涂黑，
   * 结果把分隔符也涂黑了 —— 解码器就找不到定位图案了。
   */
  private drawFinderPatterns(): void {
    const positions: Array<[number, number]> = [
      [0, 0],
      [0, this.size - 7],
      [this.size - 7, 0],
    ];
    for (const [row, col] of positions) {
      // 先把 8x8（含分隔符）整块清成白色并标记为保留区
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const rr = row + r;
          const cc = col + c;
          if (rr < 0 || rr >= this.size || cc < 0 || cc >= this.size) continue;
          this.set(rr, cc, false, true);
        }
      }
      // 再画 7x7 本体
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const isRing = r === 0 || r === 6 || c === 0 || c === 6;
          const isCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          this.set(row + r, col + c, isRing || isCore, true);
        }
      }
    }
  }

  private drawAlignmentPatterns(): void {
    const centers = ALIGNMENT_PATTERN_TABLE[this.version] ?? [];
    for (const r of centers) {
      for (const c of centers) {
        // 跳过与定位图案重叠的位置
        if (this.reserved[r][c]) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const isEdge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
            const isCenter = dr === 0 && dc === 0;
            this.set(r + dr, c + dc, isEdge || isCenter, true);
          }
        }
      }
    }
  }

  private drawTimingPatterns(): void {
    for (let i = 8; i < this.size - 8; i++) {
      const dark = i % 2 === 0;
      // 第 8 列在版本 >= 7 时被版本信息占用，不能覆盖 ——
      // 早期直接写 (i,6)，把版本信息区涂掉后高版本解码器读不到版本号。
      if (!this.reserved[6][i]) this.set(6, i, dark, true);
      if (!this.reserved[i][6]) this.set(i, 6, dark, true);
    }
  }

  /**
   * 预留格式信息区（先占位为白，稍后由 applyMaskAndFormat 写入真值）。
   *
   * 只预留在**空位**上：(6,8) 与 (8,6) 已经被定时图案占用，
   * 强行覆盖会把定时图案打断。判断依据是 reserved 标记，不是硬编码坐标。
   */
  private reserveFormatAreas(): void {
    for (let i = 0; i < 9; i++) {
      if (!this.reserved[8][i]) this.set(8, i, false, true);
      if (!this.reserved[i][8]) this.set(i, 8, false, true);
    }
    for (let i = 0; i < 8; i++) {
      const last = this.size - 1 - i;
      if (!this.reserved[8][last]) this.set(8, last, false, true);
      if (!this.reserved[last][8]) this.set(last, 8, false, true);
    }
    // 固定的暗模块
    this.set(this.size - 8, 8, true, true);
  }

  private reserveVersionAreas(): void {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        this.set(this.size - 11 + j, i, false, true);
        this.set(i, this.size - 11 + j, false, true);
      }
    }
  }

  /**
   * 写入版本信息（仅版本 >= 7）。
   *
   * 18 位 = 6 位版本号 + 12 位 BCH(18,6)，生成多项式 0x1F25，不做掩模。
   * 左右两份：右上角 6x3 与左下角 3x6，两者互为转置。
   *
   * 早期版本只「预留空位」却没写内容，结果版本 7 以上全部是白块 ——
   * 解码器拿不到版本号，只能用猜的，猜错就整张读不出来。
   */
  private writeVersionInfo(): void {
    if (this.version < 7) return;

    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;

    for (let i = 0; i < 18; i++) {
      const bit = ((bits >> i) & 1) === 1;
      const row = Math.floor(i / 3);
      const col = i % 3;
      // 右上角
      this.modules[row][this.size - 11 + col] = bit;
      // 左下角（转置）
      this.modules[this.size - 11 + col][row] = bit;
    }
  }

  private set(row: number, col: number, dark: boolean, reserved = false): void {
    if (row < 0 || row >= this.size || col < 0 || col >= this.size) return;
    this.modules[row][col] = dark;
    if (reserved) this.reserved[row][col] = true;
  }

  /** 构造数据比特流：模式指示符 + 字符数 + 数据 + 终止符 + 填充 */
  private buildDataBits(): number[] {
    const bytes = Array.from(Buffer.from(this.text, 'utf8'));
    const bits: number[] = [];

    const push = (value: number, len: number) => {
      for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
    };

    const { dataCodewords } = QrEncoder.blockStructure(this.version);
    const totalDataBits = dataCodewords * 8;

    push(0b0100, 4); // byte 模式
    push(bytes.length, CHAR_COUNT_TABLE[this.version] ?? 16);
    for (const b of bytes) push(b, 8);

    // 终止符最多 4 位（提前超长时按剩余位数给，不做截断）
    if (bits.length > totalDataBits) {
      throw new Error(`内容超出版本 ${this.version} 的容量`);
    }
    const term = Math.min(4, totalDataBits - bits.length);
    push(0, term);

    // 补齐到字节边界
    while (bits.length % 8 !== 0) bits.push(0);

    // 用 0xEC / 0x11 交替填充剩余
    let toggle = true;
    while (bits.length < totalDataBits) {
      push(toggle ? 0xec : 0x11, 8);
      toggle = !toggle;
    }

    return bits.slice(0, totalDataBits);
  }

  private bitsToCodewords(bits: number[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | (bits[i + j] || 0);
      out.push(v);
    }
    return out;
  }

  /**
   * Reed-Solomon 纠错（GF(256)，本原多项式 0x11D）。
   *
   * 分块严格按 `blockStructure()` 给的两组处理 —— 版本 8 这类
   * 「两组数据码字数不同」的版本，若当成等长块切，后面所有块的数据都会错位，
   * 表现就是纠错码全错、解码器读不出来。
   */
  private addErrorCorrection(dataCodewords: number[]): number[] {
    const { groups, ecPerBlock, totalCodewords } = QrEncoder.blockStructure(this.version);

    const blocks: Array<{ data: number[]; ec: number[] }> = [];
    let offset = 0;
    for (const g of groups) {
      for (let i = 0; i < g.count; i++) {
        const data = dataCodewords.slice(offset, offset + g.dataPerBlock);
        offset += g.dataPerBlock;
        blocks.push({ data, ec: this.reedSolomon(data, ecPerBlock) });
      }
    }

    // 交错输出：先按列取数据码字，再按列取纠错码字
    const result: number[] = [];
    const maxData = Math.max(...blocks.map((b) => b.data.length));
    for (let i = 0; i < maxData; i++) {
      for (const b of blocks) if (i < b.data.length) result.push(b.data[i]);
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (const b of blocks) if (i < b.ec.length) result.push(b.ec[i]);
    }

    if (result.length !== totalCodewords) {
      throw new Error(`码字交错长度异常: ${result.length} != ${totalCodewords}`);
    }
    return result;
  }

  private reedSolomon(data: number[], ecCount: number): number[] {
    const gen = this.rsGenerator(ecCount);
    const res = new Array(ecCount).fill(0);

    for (const byte of data) {
      const factor = byte ^ res[0];
      res.shift();
      res.push(0);
      for (let i = 0; i < ecCount; i++) {
        res[i] ^= this.gfMul(gen[i + 1], factor);
      }
    }
    return res;
  }

  private gfExp: number[] | null = null;
  private gfLog: number[] | null = null;

  private initGf(): void {
    if (this.gfExp) return;
    const exp = new Array(512);
    const log = new Array(256).fill(0);
    let x = 1;
    for (let i = 0; i < 255; i++) {
      exp[i] = x;
      log[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
    this.gfExp = exp;
    this.gfLog = log;
  }

  private gfMul(a: number, b: number): number {
    this.initGf();
    if (a === 0 || b === 0) return 0;
    return this.gfExp![this.gfLog![a] + this.gfLog![b]];
  }

  private rsGenerator(degree: number): number[] {
    this.initGf();
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= this.gfMul(poly[j], this.gfExp![i]);
      }
      poly = next;
    }
    return poly;
  }

  /** 之字形填充数据模块 */
  private placeData(codewords: number[]): void {
    const bits: number[] = [];
    for (const cw of codewords) {
      for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
    }

    let bitIndex = 0;
    let upward = true;

    for (let col = this.size - 1; col > 0; col -= 2) {
      // 第 6 列是定时图案，跳过
      if (col === 6) col = 5;

      for (let i = 0; i < this.size; i++) {
        const row = upward ? this.size - 1 - i : i;
        for (const c of [col, col - 1]) {
          if (this.reserved[row][c]) continue;
          const bit = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
          this.modules[row][c] = bit;
          bitIndex++;
        }
      }
      upward = !upward;
    }
  }

  /**
   * 施加掩模并写入格式信息。
   *
   * 掩模选 2（(row*col)%3==0 的翻转）是**实测确定**的，不是随手挑的：
   * 用参考实现 qrcode-generator 在同一载荷下逐格比对，反推出它用的
   * 正是 ec=0(M) + mask=2；格式位序也据此校正（见下方 bit14 起）。
   *
   * 这两处原本都写错了 —— 矩阵结构图案全对、只有数据区错乱，
   * 肉眼完全看不出问题，但解码器一个都读不出来。
   */
  private applyMaskAndFormat(): void {
    const mask = MASK_PATTERN;
    for (let row = 0; row < this.size; row++) {
      for (let col = 0; col < this.size; col++) {
        if (!this.reserved[row][col] && this.maskCondition(mask, row, col)) {
          this.modules[row][col] = !this.modules[row][col];
        }
      }
    }

    const formatBits = this.formatInfo(EC_LEVEL_BITS, mask);

    /**
     * 格式信息 15 位铺开。
     *
     * 位序是**低位在前**（bit0 先走），不是 bit14 先走 ——
     * 这一点由「与参考实现逐格比对」确定：
     *   formatInfo(0,2) = 101111001111100
     *   参考矩阵按同样坐标读出 = 001111100111101  ← 正好是上式的反转
     * 之前按 bit14 先走，导致 8 个角上模块翻反，解码器读不出格式信息。
     *
     * 坐标必须避开定位图案分隔符（row7/col7 恒白），但 (7,8)/(8,7) 例外 ——
     * 规范把这两个位置用作格式信息，写入前要解除保留。
     */
    const topLeft: Array<[number, number]> = [];
    for (let r = 0; r <= 5; r++) topLeft.push([r, 8]);
    topLeft.push([7, 8], [8, 8], [8, 7]);
    for (let c = 5; c >= 0; c--) topLeft.push([8, c]);

    for (let i = 0; i < 15; i++) {
      const [r, c] = topLeft[i];
      this.reserved[r][c] = false;
      this.modules[r][c] = ((formatBits >> i) & 1) === 1;
    }

    // 右上横：row8, col n-1 → n-8（bit0..bit7）
    for (let i = 0; i < 8; i++) {
      const c = this.size - 1 - i;
      this.reserved[8][c] = false;
      this.modules[8][c] = ((formatBits >> i) & 1) === 1;
    }

    // 左下竖：col8, row n-1 → n-7（bit8..bit14）
    for (let i = 0; i < 7; i++) {
      const r = this.size - 1 - i;
      this.reserved[r][8] = false;
      this.modules[r][8] = ((formatBits >> (8 + i)) & 1) === 1;
    }

    // 固定暗模块
    this.reserved[this.size - 8][8] = false;
    this.modules[this.size - 8][8] = true;
  }

  private maskCondition(mask: number, row: number, col: number): boolean {
    switch (mask) {
      case 0:
        return (row + col) % 2 === 0;
      case 1:
        return row % 2 === 0;
      case 2:
        return col % 3 === 0;
      case 3:
        return (row + col) % 3 === 0;
      case 4:
        return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
      case 5:
        return ((row * col) % 2) + ((row * col) % 3) === 0;
      case 6:
        return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
      case 7:
        return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
      default:
        throw new Error(`未知掩模: ${mask}`);
    }
  }

  private formatInfo(ecLevel: number, mask: number): number {
    const data = (ecLevel << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
  }

  /**
   * 自检：用定位图案、定时图案、以及"三个角上的定位图案形态"做结构性断言。
   *
   * 这是最后一道防线 —— 二维码算错很难用肉眼发现，
   * 宁可让接口报 500，也不能把一张扫不出来的码发给用户。
   */
  private selfCheck(): void {
    const s = this.size;
    if (s < 21 || (s - 17) % 4 !== 0) throw new Error(`二维码尺寸非法: ${s}`);

    const at = (r: number, c: number) => this.modules[r][c];

    // 三个定位图案的角必须符合 7x7 形态
    const checkFinder = (top: number, left: number) => {
      if (!at(top, left)) throw new Error('定位图案左上角未置黑');
      if (!at(top + 6, left)) throw new Error('定位图案右上角未置黑');
      if (!at(top, left + 6)) throw new Error('定位图案左下角未置黑');
      if (at(top + 1, left + 1)) throw new Error('定位图案内圈不应为黑');
      if (!at(top + 3, left + 3)) throw new Error('定位图案中心未置黑');
    };
    checkFinder(0, 0);
    checkFinder(0, s - 7);
    checkFinder(s - 7, 0);

    // 定时图案：第 6 行/列在 8..s-9 之间必须交替
    for (let i = 8; i < s - 8; i++) {
      const expected = i % 2 === 0;
      if (at(6, i) !== expected) throw new Error(`横向定时图案第 ${i} 格异常`);
      if (at(i, 6) !== expected) throw new Error(`纵向定时图案第 ${i} 格异常`);
    }

    // 暗模块
    if (!at(s - 8, 8)) throw new Error('固定暗模块缺失');
  }

  get matrix(): boolean[][] {
    return this.modules;
  }
}

/**
 * 生成 SVG 字符串。
 *
 * 用 SVG 而不是 PNG：小程序 `<image>` 直接支持 data:image/svg+xml;base64，
 * 不需要后端引入 sharp/canvas 这类原生依赖，零依赖模式下也能跑。
 */
export function toSvgDataUrl(matrix: boolean[][], scale = 8, quietZone = 4): string {
  const n = matrix.length;
  const dim = (n + quietZone * 2) * scale;

  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue;
      const x = (c + quietZone) * scale;
      const y = (r + quietZone) * scale;
      path += `M${x} ${y}h${scale}v${scale}h-${scale}z`;
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/></svg>`;

  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

/** 生成用于核销员扫的二维码内容。前缀便于扫码端识别是我们的码 */
export function buildQrPayload(token: string): string {
  return `TCV1:${token}`;
}

/** 从扫码内容里还原 token，兼容带前缀与不带前缀两种 */
export function parseQrPayload(raw: string): string {
  const s = String(raw ?? '').trim();
  return s.startsWith('TCV1:') ? s.slice(5) : s;
}
