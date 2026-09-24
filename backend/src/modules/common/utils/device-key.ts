import { createHash } from 'crypto';

/**
 * 设备密钥哈希
 *
 * 抽成独立工具而非放在 VerifyService 里：DeviceService 只需要这个纯函数，
 * 若为此把整个 VerifyService 注册进 DeviceModule，就会连带拖入
 * VerifyService 的 11 个依赖（Company/Employee/QrCode/... 仓库），
 * 造成不必要的模块耦合与 DI 报错。
 */
export function hashDeviceKey(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

/** 生成一机一密钥：返回明文、哈希、以及用于列表辨识的前缀 */
export function generateDeviceKey() {
  const plain = createHash('sha256')
    .update(`${Date.now()}-${Math.random()}-${process.pid}`)
    .digest('hex')
    .slice(0, 48);
  return {
    plain,
    hash: hashDeviceKey(plain),
    prefix: plain.slice(0, 8),
  };
}
