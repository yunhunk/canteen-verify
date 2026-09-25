import { PRIMARY_ID_TYPE } from './id-type';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 核销设备（扫码枪 / 闸机）
 *
 * 一机一密钥：密钥明文仅在登记 / 换发时返回一次，库里只存哈希。
 * 好处是单台设备泄密可以只停用那一台，而不是全平台换钥匙。
 * key_prefix 仅供后台列表辨识，不可用于鉴权。
 *
 * key_hash 长度 255：v2 scrypt 哈希为 `v2$` + 128 hex = 131 字符，
 * 旧 sha256 为 64 字符。早期字段是 varchar(64)，scrypt 改造后写不进去
 * 导致「Data too long for column 'key_hash'」，故扩至 255 留足余量。
 */
@Entity('devices')
@Index('uk_key_hash', ['key_hash'], { unique: true })
@Index('idx_store', ['store_id'])
export class Device {
  @PrimaryGeneratedColumn({ type: PRIMARY_ID_TYPE })
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  key_hash: string;

  @Column({ type: 'varchar', length: 16 })
  key_prefix: string;

  /** 绑定门店；非空时核销落点以设备为准，忽略请求传入的 storeId */
  @Column({ type: 'bigint', nullable: true })
  store_id: string | null;

  @Column({ type: 'bigint', nullable: true })
  company_id: string | null;

  @Column({ type: 'tinyint', default: 1 })
  status: number;

  @Column({ type: 'datetime', nullable: true })
  last_used_at: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}
