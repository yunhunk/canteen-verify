import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../config/app.config';

interface CacheEntry {
  value: string;
  expireAt: number;
}

/**
 * 锁 / 计数服务
 *
 * 优先用 Redis（生产），连不上时降级为进程内 Map（本地零依赖模式）。
 *
 * 降级只对「单实例本地开发」成立 —— 多实例部署下内存锁各实例互不可见，
 * 防重复核销会失效。所以启动时必须把这件事喊出来，不能让它在生产里静默降级。
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RedisService');
  private client: any = null;
  private degraded = false;
  private readonly memory = new Map<string, CacheEntry>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async onModuleInit() {
    if (this.config.localMode) {
      this.enableDegraded('LOCAL_MODE=1 本地零依赖模式');
      return;
    }
    try {
      const Redis = require('ioredis');
      this.client = new Redis({
        host: this.config.redis.host,
        port: this.config.redis.port,
        password: this.config.redis.password,
        lazyConnect: false,
        maxRetriesPerRequest: 2,
        retryStrategy: (times: number) => {
          // 指数退避：1s → 2s → 4s → 8s → 16s，最多 5 次后放弃降级
          if (times > 5) return null;
          return Math.min(1000 * 2 ** (times - 1), 16000);
        },
      });
      await this.client.ping();
      this.logger.log(`Redis 已连接 ${this.config.redis.host}:${this.config.redis.port}`);
    } catch (e) {
      // ping 失败说明 maxRetriesPerRequest 已耗尽，主动断开避免后台重连泄漏连接
      this.client?.disconnect?.();
      this.client = null;

      // ── 生产环境：fail-closed，宁可起不来也不静默降级 ──
      //
      // 降级到进程内 Map 后，这些原语会退化成「单进程语义」：
      //   • 限流按进程各算一份 → N 个副本时可放大 N 倍
      //   • 占位去重各进程互不可见 → 防重复核销只剩 DB 条件更新兜底
      // 影响面是纵深防御层，虽然权威的 DB 条件 UPDATE 仍能防住重复核销，
      // 但「限流实际失效」属于必须让运维立刻知道的事故，
      // 静默降级会让它在无人察觉的情况下持续很久（CWE-693）。
      //
      // 因此生产直接抛错终止启动，由编排层的健康检查/重启策略处理。
      // 若确需在无 Redis 环境临时跑生产，显式设 ALLOW_REDIS_DEGRADED=1。
      const allowDegraded = process.env.ALLOW_REDIS_DEGRADED === '1';
      if (!allowDegraded) {
        this.logger.error(
          `Redis 连接失败：${(e as Error).message}。` +
            `生产环境拒绝降级启动 —— 降级会使限流与占位去重退化为单进程语义。` +
            `请恢复 Redis，或显式设置 ALLOW_REDIS_DEGRADED=1 承担该风险。`,
        );
        throw new Error(
          `Redis 不可用且未允许降级（ALLOW_REDIS_DEGRADED≠1），拒绝启动`,
        );
      }

      this.enableDegraded(`Redis 连接失败（已显式允许降级）：${(e as Error).message}`);
    }
  }

  async onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.client) await this.client.quit().catch(() => undefined);
  }

  private enableDegraded(reason: string) {
    this.degraded = true;
    this.logger.warn(
      `[降级] 使用进程内内存锁 —— ${reason}。` +
        `仅适用于单实例本地开发；多实例部署下防重复核销会失效，生产请确保 Redis 可用。`,
    );
    // 定期清理过期键，避免内存无限增长
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref?.();
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.memory) {
      if (v.expireAt <= now) this.memory.delete(k);
    }
  }

  get isDegraded() {
    return this.degraded;
  }

  /**
   * 原子占位（SET NX EX 语义）。
   * 返回 true = 占位成功（首次），false = 已存在（重复请求）。
   */
  async setNx(key: string, ttlSeconds: number, value = '1'): Promise<boolean> {
    if (this.client) {
      const r = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
      return r === 'OK';
    }
    const now = Date.now();
    const existing = this.memory.get(key);
    if (existing && existing.expireAt > now) return false;
    this.memory.set(key, { value, expireAt: now + ttlSeconds * 1000 });
    return true;
  }

  async get(key: string): Promise<string | null> {
    if (this.client) return this.client.get(key);
    const e = this.memory.get(key);
    if (!e || e.expireAt <= Date.now()) return null;
    return e.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.client) {
      if (ttlSeconds) await this.client.set(key, value, 'EX', ttlSeconds);
      else await this.client.set(key, value);
      return;
    }
    this.memory.set(key, {
      value,
      expireAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : Number.MAX_SAFE_INTEGER,
    });
  }

  async del(key: string): Promise<void> {
    if (this.client) {
      await this.client.del(key);
      return;
    }
    this.memory.delete(key);
  }

  /** 计数器自增，返回自增后的值（用于登录失败限流） */
  async incr(key: string, ttlSeconds: number): Promise<number> {
    if (this.client) {
      const n = await this.client.incr(key);
      if (n === 1 && ttlSeconds) await this.client.expire(key, ttlSeconds);
      return n;
    }
    const now = Date.now();
    const e = this.memory.get(key);
    if (!e || e.expireAt <= now) {
      this.memory.set(key, { value: '1', expireAt: now + ttlSeconds * 1000 });
      return 1;
    }
    const next = String(Number(e.value) + 1);
    this.memory.set(key, { value: next, expireAt: e.expireAt });
    return Number(next);
  }
}
