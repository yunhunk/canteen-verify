import { createHash, randomBytes, scryptSync } from 'crypto';

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
 * salt 为固定值 —— 因为 hashDeviceKey 需要**确定性**（用哈希值做 DB
 * 查找），随机 salt 会破坏这一前提。固定 salt 在这里可以接受：
 * 设备密钥本身是 48 字符的高熵随机串（192 bit），不存在字典攻击
 * 的空间，salt 的作用只是防止跨系统彩虹表复用。
 *
 * ## 版本前缀 v2$
 *
 * 旧实现（sha256）产出的 64 字符 hex 与 scrypt 的产物无法区分，
 * 且历史上线上库里**同时存在**两种哈希。为了能平滑迁移、不让已
 * 登记的设备失效，新哈希统一加 `v2$` 前缀：
 *
 *   - 带 `v2$`  → scrypt 哈希
 *   - 裸 64 字符 → 旧 sha256 哈希（兼容期回溯用）
 *
 * 字段长度相应扩到 255（见 device.entity.ts），留足余量。
 */
const DEVICE_KEY_SALT = 'tc-device-key-scrypt-salt-v2';

/** 版本前缀：标识这是 v2（scrypt）哈希 */
export const KEY_HASH_V2_PREFIX = 'v2$';

/** scrypt 派生密钥长度（字节）；hex 后为 128 字符，加前缀共 131 */
const KEY_LEN = 64;

/**
 * 新哈希：scrypt + 版本前缀。
 *
 * 用于**写入**（登记新设备 / 换发密钥）与**查询**。
 */
export function hashDeviceKey(plain: string): string {
  return KEY_HASH_V2_PREFIX + scryptSync(plain, DEVICE_KEY_SALT, KEY_LEN).toString('hex');
}

/**
 * 旧哈希：裸 sha256，仅用于兼容期回溯查询历史数据。
 *
 * ⚠️ 不要用于写入新数据 —— 这是为了不破坏已登记设备而保留的。
 */
export function hashDeviceKeyLegacy(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

/**
 * 计算一个明文密钥可能对应的**所有**历史哈希形态。
 *
 * 设备鉴权时用这个列表去库中查（`key_hash IN (...)`），
 * 这样无论设备是哪个时期登记的都能验通。
 *
 * 返回顺序：v2 优先（命中概率高，且是当前唯一写入格式）。
 */
export function candidateHashes(plain: string): string[] {
  return [hashDeviceKey(plain), hashDeviceKeyLegacy(plain)];
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
