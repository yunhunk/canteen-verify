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
 * 员工
 *
 * 一人一号：phone 唯一 + 登录后绑定 openid。
 * 「停用」为逻辑删除（status=0），停用后禁止核销、二维码失效，
 * 但历史核销记录保留，便于统计对账。
 */
@Entity('employees')
@Index('uk_phone', ['phone'], { unique: true })
@Index('uk_openid', ['openid'], { unique: true })
@Index('idx_employees_company', ['company_id', 'status'])
export class Employee {
  @PrimaryGeneratedColumn({ type: PRIMARY_ID_TYPE })
  id: string;

  @Column({ type: 'bigint' })
  company_id: string;

  @Column({ type: 'varchar', length: 50 })
  name: string;

  @Column({ type: 'varchar', length: 20 })
  phone: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  openid: string | null;

  @Column({ name: 'employee_no', type: 'varchar', length: 50, nullable: true })
  employee_no: string | null;

  @Column({ type: 'tinyint', default: 1 })
  status: number;

  /**
   * 会话版本号。每次「解绑微信」递增，用于让该员工的旧 token 立即失效。
   *
   * 为什么必须有：JWT 无状态，员工端为了性能**不走查库校验**，
   * 于是解绑后对方手里的 token 还能一直用到过期 —— 管理员会看到
   * 列表上写着「未绑定」、员工手机上却照样能出码，等于解绑没生效。
   * 递增此字段后 Guard 一比对就让旧会话作废（见 jwt-auth.guard.ts）。
   *
   * 默认 1 而非 0，是为了让历史上已签发、payload 里没有 tv 的旧 token
   * 按 1 处理，上线时不会把在线员工全部踢下线。
   */
  @Column({ name: 'token_version', type: 'int', default: 1 })
  token_version: number;

  /**
   * 公司分配给该员工的核销总次数。
   *
   * NULL = 不限制 —— 这是**默认值**，保证新增字段后老租户行为完全不变
   * （历史员工全部为 NULL，等于没有个人额度这个概念）。
   * 明确设为 0 则表示一次都不允许核销。
   */
  @Column({ name: 'quota_total', type: 'int', nullable: true })
  quota_total: number | null;

  /**
   * 已核销次数。只增不减，是唯一权威计数 ——
   * 剩余次数一律用 quota_total - quota_used 现算，不再冗余存 remain，
   * 避免两个字段不同步。
   */
  @Column({ name: 'quota_used', type: 'int', default: 0 })
  quota_used: number;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}
