import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config/app.config';
import { ensureDatabase } from './database/ensure-database';

async function bootstrap() {
  const config = loadConfig();

  // 本地零依赖模式：建表 + 灌种子数据
  if (config.localMode) {
    await ensureDatabase();
  }

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

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
