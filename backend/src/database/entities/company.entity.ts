import { PRIMARY_ID_TYPE } from './id-type';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 公司（租户） */
@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn({ type: PRIMARY_ID_TYPE })
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  contact_name: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  contact_phone: string | null;

  @Column({ type: 'bigint', nullable: true })
  plan_id: string | null;

  @Column({ type: 'int', default: 0 })
  total_quota: number;

  /** 剩余次数（冗余字段，便于看板直接读，权威值仍以原子扣减为准） */
  @Column({ type: 'int', default: 0 })
  remain_quota: number;

  /**
   * 餐标（元）。NULL = 未设置。
   *
   * 公司统一一个餐标，**只用于展示与核销机器语音播报**（"核销成功，餐标15元"），
   * 不参与扣减：一次核销永远扣 1 次。
   *
   * 注意 decimal 在 MySQL 上会被驱动读成字符串（避免精度丢失），
   * 对外一律用 Number() 归一，别把 '15.00' 直接扔给前端。
   */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  meal_standard: string | null;

  @Column({ type: 'tinyint', default: 1 })
  status: number;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}
