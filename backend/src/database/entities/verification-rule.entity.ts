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
 * 核销时段限制规则
 *
 * 设计要点：
 * 1. 时间用 `HH:mm` 字符串而非 TIME 类型 —— 本地零依赖模式用 SQLite 没有 TIME，
 *    TypeORM 映射会不一致；而 `HH:mm` 定宽零填充，字符串比较即可判定区间。
 * 2. end_time < start_time 表示跨天（如 22:00-02:00）。
 * 3. 完全没配启用规则 = 不限制 —— 老租户升级后行为不变，刻意的兼容设计。
 * 4. 多条规则同时命中取最宽松的一条。
 * 5. 规则不追溯既往：创建时间之前的核销 rule_id 为空，不计入。
 */
@Entity('verification_rules')
@Index('idx_rules_company', ['company_id', 'status'])
export class VerificationRule {
  @PrimaryGeneratedColumn({ type: PRIMARY_ID_TYPE })
  id: string;

  @Column({ type: 'bigint' })
  company_id: string;

  @Column({ type: 'varchar', length: 50 })
  name: string;

  @Column({ type: 'varchar', length: 5 })
  start_time: string;

  @Column({ type: 'varchar', length: 5 })
  end_time: string;

  /** 每人该时段内可核销次数，0 = 不限 */
  @Column({ type: 'int', default: 1 })
  per_employee_limit: number;

  @Column({ type: 'tinyint', default: 1 })
  status: number;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}
