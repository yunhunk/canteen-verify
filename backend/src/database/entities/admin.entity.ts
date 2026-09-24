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
 * 管理员
 *
 * company_id 为空 = 平台超管（可跨租户）；非空 = 公司管理员。
 *
 * token_version 是会话吊销的关键：JWT 无状态且默认 7 天有效，
 * 若只验签名，超管把某管理员停用/改密/删除后，对方手里的旧 token
 * 仍能用到过期 —— 这是真实的安全缺口。改密/停用/启用即递增此字段，
 * Guard 比对 payload.tv 与库中值即可让旧 token 立即失效。
 */
@Entity('admins')
@Index('uk_username', ['username'], { unique: true })
@Index('idx_admin_company', ['company_id'])
export class Admin {
  @PrimaryGeneratedColumn({ type: PRIMARY_ID_TYPE })
  id: string;

  @Column({ type: 'varchar', length: 50 })
  username: string;

  @Column({ type: 'varchar', length: 255 })
  password_hash: string;

  @Column({ type: 'bigint', nullable: true })
  company_id: string | null;

  /** super / company */
  @Column({ type: 'varchar', length: 20 })
  role: string;

  @Column({ type: 'tinyint', default: 1 })
  status: number;

  @Column({ type: 'int', default: 1 })
  token_version: number;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}
