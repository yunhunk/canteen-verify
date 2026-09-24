import { PRIMARY_ID_TYPE } from './id-type';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** 核销二维码：type 2 = 动态码（5 分钟一次性），1 = 静态码 */
@Entity('qr_codes')
@Index('uk_token', ['token'], { unique: true })
@Index('idx_qr_employee', ['employee_id', 'status'])
export class QrCode {
  @PrimaryGeneratedColumn({ type: PRIMARY_ID_TYPE })
  id: string;

  @Column({ type: 'bigint' })
  company_id: string;

  @Column({ type: 'bigint' })
  employee_id: string;

  @Column({ type: 'tinyint', default: 2 })
  type: number;

  @Column({ type: 'varchar', length: 64 })
  token: string;

  /**
   * 1 = 有效待核销；0 = 作废（刷新换码 / 停用 / 解绑 / 过期清理）；
   * 2 = 已核销（一次性使用完成）。
   *
   * 2 不能和 0 混：员工端「已核销（套餐档）」的占位提示要能从库里区分
   * "这码用掉了"和"这码被换掉/作废了"——混在一起员工端就只能瞎猜。
   */
  @Column({ type: 'tinyint', default: 1 })
  status: number;

  @Column({ type: 'datetime', nullable: true })
  expire_at: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;
}
