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
 * 一机一密钥：密钥明文仅在登记 / 换发时返回一次，库里只存 sha256。
 * 好处是单台设备泄密可以只停用那一台，而不是全平台换钥匙。
 * key_prefix 仅供后台列表辨识，不可用于鉴权。
 */
@Entity('devices')
@Index('uk_key_hash', ['key_hash'], { unique: true })
@Index('idx_store', ['store_id'])
export class Device {
  @PrimaryGeneratedColumn({ type: PRIMARY_ID_TYPE })
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 64 })
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
