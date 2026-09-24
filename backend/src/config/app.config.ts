import { ENTITIES } from '../database/entities';
import { existsSync } from 'fs';
import { resolve } from 'path';

/**
 * 加载 .env 文件（只做一次，且不覆盖已存在的环境变量）。
 *
 * 为什么手写而不是装 dotenv：
 * 项目保持「零运行时依赖膨胀」的取向，而解析 .env 只需要十几行 ——
 * KEY=VALUE、# 注释、可有可无的引号，这点语法不值得引一个包。
 *
 * ⚠️ 不覆盖 process.env 里已有的值：pm2 / docker / systemd 注入的环境变量
 *    优先级必须高于文件，否则线上改配置要连文件一起改，容易出错。
 */
function loadDotEnv(): void {
  const file = resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;

  let text: string;
  try {
    text = require('fs').readFileSync(file, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // 去掉成对的引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // 已有值优先（容器/systemd 注入的覆盖文件）
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

/** 依赖注入 token：注入配置时用 @Inject(APP_CONFIG) */
export const APP_CONFIG = 'APP_CONFIG';

export interface AppConfig {
  port: number;
  /**
   * 监听地址。默认 0.0.0.0 便于本地开发；
   * **生产若有反向代理必须设 127.0.0.1**，否则后端端口直接暴露公网，
   * 攻击者可绕过 nginx 直打后端（限流/审计/WAF 形同虚设）。
   */
  host: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  /** 本地零依赖模式：SQLite(WASM)，无需 MySQL/Redis */
  localMode: boolean;
  db: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    synchronize: boolean;
  };
  redis: {
    host: string;
    port: number;
  };
  wechat: {
    appId: string;
    appSecret: string;
  };
  /**
   * 是否允许旧的全局设备 token 走 /api/device/verify。
   * 生产必须为 0 —— 否则「一把钥匙丢 = 全平台设备失守」。
   */
  allowLegacyDeviceToken: boolean;
  /** 动态二维码有效期（秒） */
  qrcodeTtlSeconds: number;
}

export const loadConfig = (): AppConfig => {
  const localMode = process.env.LOCAL_MODE === '1';
  return {
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '0.0.0.0',
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me-in-production',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    localMode,
    db: {
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      username: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || 'root',
      database: process.env.DB_NAME || 'canteen_verify',
      // 生产库结构变更走 migration，绝不 synchronize
      synchronize: process.env.DB_SYNC === '1',
    },
    redis: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
    },
    wechat: {
      appId: process.env.WX_APPID || '',
      appSecret: process.env.WECHAT_APPSECRET || process.env.WX_SECRET || '',
    },
    allowLegacyDeviceToken: process.env.ALLOW_LEGACY_DEVICE_TOKEN
      ? process.env.ALLOW_LEGACY_DEVICE_TOKEN === '1'
      : localMode, // 本地模式默认放开，便于老脚本复用；生产需显式设 0
    qrcodeTtlSeconds: Number(process.env.QRCODE_TTL || 300),
  };
};

/** 数据源选项：本地模式走 SQLite(WASM)，否则 MySQL */
export function buildDataSourceOptions(config: AppConfig) {
  if (config.localMode) {
    const path = require('path');
    return {
      type: 'sqljs' as const,
      location: path.join(__dirname, '..', '..', 'local.db'),
      autoSave: true,
      entities: ENTITIES,
      synchronize: false,
    };
  }
  return {
    type: 'mysql' as const,
    host: config.db.host,
    port: config.db.port,
    username: config.db.username,
    password: config.db.password,
    database: config.db.database,
    entities: ENTITIES,
    synchronize: config.db.synchronize,
    charset: 'utf8mb4',
    timezone: '+08:00',
  };
}
