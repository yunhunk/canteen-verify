import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadConfig } from './config/app.config';
import { ensureDatabase } from './database/ensure-database';

async function bootstrap() {
  const config = loadConfig();

  // 本地零依赖模式：建表 + 灌种子数据
  if (config.localMode) {
    await ensureDatabase();
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // ── 反代信任配置 ──
  // 生产环境位于 nginx 之后，必须显式声明受信跳数，否则 Express 的 req.ip
  // 会取到 nginx 容器 IP（所有请求同一个值），且无法安全解析 X-Forwarded-For。
  //
  // 设为 1 表示「只信任紧邻的一跳」：Express 会从 XFF 右侧剥离 1 个地址，
  // 取到真实客户端。绝不能设 true —— 那会信任客户端伪造的整条链。
  //
  // 本地模式无代理，保持 false，req.ip 直接取 socket 对端。
  app.set('trust proxy', config.localMode ? false : 1);

  // 全局 DTO 校验：白名单 + 自动转型，多余字段直接剔除
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      forbidNonWhitelisted: false,
    }),
  );

  // CSV 导出等场景需要拿到原始响应对象，关闭内置 body parser 的干扰
  // P0-6 修复：CORS 白名单制，禁止 origin:true 全站放行
  const allowedOrigins = config.localMode
    ? true
    : [process.env.CORS_ORIGIN].filter(Boolean) as string[];
  app.enableCors(
    config.localMode
      ? { origin: true, credentials: true }
      : { origin: allowedOrigins, credentials: true },
  );

  const port = config.port;
  // 监听地址可配：默认 0.0.0.0（本地开发方便）。
  // 生产上如果前面有 nginx 反代，应设为 127.0.0.1，
  // 否则后端端口会直接暴露公网 —— 绕过反代直打后端，限流/审计/WAF 全部失效。
  const host = config.host;
  await app.listen(port, host);

  const logger = new Logger('Bootstrap');
  logger.log(`服务已启动：http://${host}:${port}`);
  logger.log(
    config.localMode
      ? '运行模式：本地零依赖（SQLite WASM + 内存锁降级）'
      : `运行模式：生产（MySQL ${config.db.host}:${config.db.port}）`,
  );
  if (!config.localMode && config.allowLegacyDeviceToken) {
    logger.warn(
      '⚠️  ALLOW_LEGACY_DEVICE_TOKEN 处于开启状态 —— 旧的全局设备密钥仍可用。' +
        '生产环境应设为 0，否则一把钥匙泄露即全平台设备失守。',
    );
  }
}

bootstrap();
