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
    password?: string;
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

  // ═══ P0 修复：生产模式启动校验，拒绝带病运行 ═══
  if (!localMode) {
    const jwtSecret = process.env.JWT_SECRET || '';
    if (!jwtSecret || jwtSecret === 'dev-secret-change-me-in-production' || jwtSecret.length < 32) {
      throw new Error('生产环境必须配置 JWT_SECRET（≥32字符，用 openssl rand -hex 32 生成）');
    }
    if (!process.env.WX_APPID || !process.env.WECHAT_APPSECRET) {
      throw new Error('生产环境必须配置 WX_APPID 和 WECHAT_APPSECRET');
    }
    // 漏洞 23242：绝不允许以默认弱口令连数据库。
    // 弱默认（root/root）一旦随镜像/Dockerfile 泄漏，等于给攻击者留后门，
    // 因此生产模式必须显式配置 DB_USER / DB_PASSWORD，否则直接拒绝启动。
    const dbUser = process.env.DB_USER;
    const dbPassword = process.env.DB_PASSWORD;
    if (!dbUser || !dbPassword) {
      throw new Error('生产环境必须显式配置 DB_USER 和 DB_PASSWORD');
    }
    if (dbPassword === 'root' || dbPassword === 'password' || dbPassword.length < 12) {
      throw new Error('DB_PASSWORD 强度不足（禁用 root/password 等弱口令，长度须 ≥12）');
    }
    process.env.ALLOW_LEGACY_DEVICE_TOKEN = '0';
  }

  return {
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '0.0.0.0',
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me-in-production',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    localMode,
    db: {
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      // 不再提供 'root' 兜底：本地模式无 MySQL，生产模式上面已强制校验。
      // 保留空串兜底只影响 localMode（SQLite 不用这些字段）。
      username: process.env.DB_USER || '',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'canteen_verify',
      synchronize: localMode ? false : false,
    },
    redis: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
    },
    wechat: {
      appId: process.env.WX_APPID || '',
      appSecret: process.env.WECHAT_APPSECRET || process.env.WX_SECRET || '',
    },
    allowLegacyDeviceToken: localMode
      ? process.env.ALLOW_LEGACY_DEVICE_TOKEN !== '0'
      : false,
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
