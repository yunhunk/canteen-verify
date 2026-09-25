import { createHash, randomBytes, scrypt, scryptSync } from 'crypto';

/**
 * 设备密钥哈希（版本化）
 *
 * 抽成独立工具而非放在 VerifyService 里：DeviceService 只需要这个纯函数，
 * 若为此把整个 VerifyService 注册进 DeviceModule，就会连带拖入
 * VerifyService 的 11 个依赖（Company/Employee/QrCode/... 仓库），
 * 造成不必要的模块耦合与 DI 报错。
 *
 * ## 为什么用 scrypt 而不是裸 sha256
 *
 * sha256 是快速哈希，key_hash 一旦泄露，攻击者可以每秒跑数十亿次
 * 尝试，配合彩虹表几乎等于明文。scrypt 是慢速 KDF，单次计算需要
 * 显著的内存与时间成本，离线爆破的代价高出几个数量级。
 *
 * salt 为固定值 —— 因为哈希需要**确定性**（用哈希值做 DB 查找），
 * 随机 salt 会破坏这一前提。固定 salt 在这里可以接受：
 * 设备密钥本身是 48 字符的高熵随机串（192 bit），不存在字典攻击
 * 的空间，salt 的作用只是防止跨系统彩虹表复用。
 *
 * ## 版本前缀 v2$
 *
 * 旧实现（sha256）产出的 64 字符 hex 与 scrypt 的产物无法区分，
 * 且历史上线上库里**同时存在**两种哈希。为了平滑迁移、不让已登记
 * 的设备失效，新哈希统一加 `v2$` 前缀：
 *
 *   - 带 `v2$`   → scrypt 哈希
 *   - 裸 64 字符 → 旧 sha256 哈希（兼容期回溯用）
 *
 * 字段长度相应扩到 255（见 device.entity.ts），留足余量。
 *
 * ## 为什么同时提供同步与异步两套
 *
 * scrypt 是内存硬函数（默认参数单次约 16MiB、数十毫秒）。用同步版本
 * 会让 Node 事件循环在这段时间完全停摆 —— 未认证的 /api/device/verify
 * 若被并发打满，整个服务（含其他租户的正常请求）都会卡住，这是典型的
 * 算法复杂度放大拒绝服务（CWE-770）。
 *
 * 因此：
 *   • **鉴权路径（高频、可被未认证者触发）用 candidateHashesAsync**
 *     —— 计算跑在 libuv 线程池，不阻塞事件循环；
 *   • 写入路径（登记/换发设备，低频且已鉴权）保留同步版本，
 *     便于在非 async 上下文中调用。
 */
const DEVICE_KEY_SALT = 'tc-device-key-scrypt-salt-v2';

/** 版本前缀：标识这是 v2（scrypt）哈希 */
export const KEY_HASH_V2_PREFIX = 'v2$';

/**
 * scrypt 派生密钥长度（字节）；hex 后为 128 字符，加前缀共 131。
 *
 * N=16384, r=8, p=1 为 Node 默认参数，内存开销约 16MiB。
 */
const KEY_LEN = 64;

/**
 * 新哈希（同步）：scrypt + 版本前缀。
 *
 * 用于**写入**（登记新设备 / 换发密钥）。
 * ⚠️ 不要用在请求处理路径 —— 会阻塞事件循环，请用 hashDeviceKeyAsync。
 */
export function hashDeviceKey(plain: string): string {
  return KEY_HASH_V2_PREFIX + scryptSync(plain, DEVICE_KEY_SALT, KEY_LEN).toString('hex');
}

/**
 * 新哈希（异步）：scrypt + 版本前缀。
 *
 * 用于**鉴权查询**等请求处理路径 —— 计算在 libuv 线程池执行，
 * 不阻塞主事件循环，从根上消除放大 DoS 的可能。
 */
export function hashDeviceKeyAsync(plain: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(plain, DEVICE_KEY_SALT, KEY_LEN, (err, derived) => {
      if (err) return reject(err);
      resolve(KEY_HASH_V2_PREFIX + derived.toString('hex'));
    });
  });
}

/**
 * 旧哈希：裸 sha256，仅用于兼容期回溯查询历史数据。
 *
 * ⚠️ 不要用于写入新数据 —— 这是为了不破坏已登记设备而保留的。
 * 新部署应通过轮换密钥逐步淘汰该格式。
 *
 * ═══ 漏洞 fb0a0：旧 sha256 形态必须可关停 ═══
 * 裸 sha256 是快速哈希，一旦库被拖走即可离线爆破，长期保留等于
 * 永久保留一个弱口令通道。因此加开关 ALLOW_LEGACY_KEY_HASH：
 *   • 默认（未设置）：本地/开发便捷，保持兼容；
 *   • 生产（!localMode）：**默认关闭**，只接受 v2$ 前缀；
 *   • 显式设 ALLOW_LEGACY_KEY_HASH=1 可在迁移期临时打开。
 * 配合 deploy/migrations 里的轮换脚本把历史 sha256 行改写成 v2$ 后，
 * 即可永久关停该通道。
 */
export function hashDeviceKeyLegacy(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

/** 是否允许回溯旧 sha256 哈希。生产默认关闭，见上方说明。 */
export function isLegacyKeyHashAllowed(): boolean {
  if (process.env.ALLOW_LEGACY_KEY_HASH === '1') return true;
  if (process.env.ALLOW_LEGACY_KEY_HASH === '0') return false;
  // 未显式设置：生产（非 LOCAL_MODE）默认拒绝，本地默认允许
  return process.env.LOCAL_MODE === '1';
}

/**
 * 计算一个明文密钥可能对应的**所有**历史哈希形态（同步版）。
 *
 * 仅用于写入侧与测试；请求路径请用 candidateHashesAsync。
 * 返回顺序：v2 优先（命中概率高，且是当前唯一写入格式）。
 * 旧 sha256 是否纳入取决于 isLegacyKeyHashAllowed()。
 */
export function candidateHashes(plain: string): string[] {
  const list = [hashDeviceKey(plain)];
  if (isLegacyKeyHashAllowed()) list.push(hashDeviceKeyLegacy(plain));
  return list;
}

/**
 * 异步版的候选哈希计算（**鉴权路径专用**）。
 *
 * v2 走异步 scrypt；legacy 的 sha256 极快，同步计算无影响。
 * 生产默认不再接受 legacy 形态（漏洞 fb0a0）。
 */
export async function candidateHashesAsync(plain: string): Promise<string[]> {
  const v2 = await hashDeviceKeyAsync(plain);
  const list = [v2];
  if (isLegacyKeyHashAllowed()) list.push(hashDeviceKeyLegacy(plain));
  return list;
}

/** 生成一机一密钥：返回明文、哈希、以及用于列表辨识的前缀 */
export function generateDeviceKey() {
  const plain = randomBytes(32).toString('hex').slice(0, 48);
  return {
    plain,
    hash: hashDeviceKey(plain),
    prefix: plain.slice(0, 8),
  };
}
