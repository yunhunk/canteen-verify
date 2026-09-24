import { PRIMARY_ID_TYPE } from './id-type';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * 操作日志：公司后台 + 平台总后台共用
 *
 * 关键设计：
 * 1. 冗余存操作人快照（operator_name / operator_role）。若只存外键，
 *    操作人离职或被删后日志就变成「匿名操作」，审计价值归零。
 * 2. 故意吞掉自身异常：日志写入失败绝不能反过来阻断主业务，
 *    否则一次日志表超时就能让正常核销失败，本末倒置。
 * 3. 只追加：没有 updated_at，也不提供修改/删除接口 ——
 *    日志的可信度就在于「一旦写入不可篡改」。
 */
@Entity('operation_logs')
@Index('idx_logs_company_time', ['company_id', 'created_at'])
@Index('idx_logs_operator', ['operator_id'])
@Index('idx_logs_module_action', ['module', 'action'])
export class OperationLog {
  @PrimaryGeneratedColumn({ type: PRIMARY_ID_TYPE })
  id: string;

  /** 空 = 平台级操作（超管跨公司动作）；非空 = 某公司内操作 */
  @Column({ type: 'bigint', nullable: true })
  company_id: string | null;

  /** auth / company / employee / admin / device / store / plan / rule / verify */
  @Column({ type: 'varchar', length: 50 })
  module: string;

  /** create / update / delete / status / login / login_fail / recharge / reset_password / rotate_key / verify */
  @Column({ type: 'varchar', length: 50 })
  action: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @Column({ type: 'bigint', nullable: true })
  operator_id: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  operator_name: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  operator_role: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  target_type: string | null;

  @Column({ type: 'bigint', nullable: true })
  target_id: string | null;

  /** 变更明细 JSON 快照（before / after / 数量 / 关联 id） */
  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;
}
