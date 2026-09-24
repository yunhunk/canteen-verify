import { PRIMARY_ID_TYPE } from './id-type';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * 核销 / 消费记录
 *
 * 只追加，不修改。`rule_id` 是「该员工在这条时段规则下已核销几次」的统计口径，
 * 不能靠时间比较替代 —— DATETIME 精度只到秒，同一秒内「先核销、后建规则」
 * 分不出来，会追溯误算（详见设计文档 4.2 第 e 步）。
 */
@Entity('consumptions')
@Index('idx_company_time', ['company_id', 'verify_time'])
@Index('idx_employee', ['employee_id'])
@Index('idx_rule_employee_time', ['rule_id', 'employee_id', 'verify_time'])
export class Consumption {
  @PrimaryGeneratedColumn({ type: PRIMARY_ID_TYPE })
  id: string;

  /** 冗余租户 id —— 核心统计维度，避免每次统计都联表 employees */
  @Column({ type: 'bigint' })
  company_id: string;

  @Column({ type: 'bigint' })
  employee_id: string;

  @Column({ type: 'bigint', nullable: true })
  qrcode_id: string | null;

  @Column({ type: 'bigint', nullable: true })
  store_id: string | null;

  @Column({ type: 'datetime' })
  verify_time: Date;

  @Column({ type: 'int', default: 1 })
  deduct_quota: number;

  /** 核销员 id（员工代扫时为员工 id，设备核销时为 null） */
  @Column({ type: 'bigint', nullable: true })
  verifier_id: string | null;

  /** 本次核销归属的时段规则；为空表示核销时该公司无启用规则 */
  @Column({ type: 'bigint', nullable: true })
  rule_id: string | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;
}
