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
 * 员工反馈（意见 / 建议 / 投诉）
 *
 * 设计要点：
 * 1. **可见范围只到平台** —— 公司管理员看不到本公司员工的反馈。
 *    员工投诉的对象常常就是公司/食堂本身，若公司端能看，
 *    这个功能就没人敢用了。公司端**不提供任何反馈接口**（不是前端隐藏，是后端没有）。
 * 2. 冗余存员工与公司快照（employee_name / company_name）：员工离职或被删后
 *    反馈不该变成「匿名投诉」，否则平台无从处理。
 * 3. 冗余存 company_id 保持租户维度可筛选（平台按公司看投诉集中度），
 *    但这只是**平台侧的筛选维度**，不代表公司端有权限。
 * 4. 状态流转：0 待处理 → 1 已处理。回复内容与处理时间一起记。
 */
@Entity('feedbacks')
@Index('idx_feedbacks_company_status', ['company_id', 'status'])
@Index('idx_feedbacks_status_time', ['status', 'created_at'])
export class Feedback {
  @PrimaryGeneratedColumn({ type: PRIMARY_ID_TYPE })
  id: string;

  @Column({ type: 'bigint' })
  company_id: string;

  @Column({ type: 'bigint' })
  employee_id: string;

  /** 提交时的员工姓名快照 —— 员工被删后仍可追溯 */
  @Column({ type: 'varchar', length: 50, nullable: true })
  employee_name: string | null;

  /** 提交时的公司名快照 */
  @Column({ type: 'varchar', length: 100, nullable: true })
  company_name: string | null;

  /** issue 问题反馈 / suggest 功能建议 / complaint 投诉 / other 其他 */
  @Column({ type: 'varchar', length: 20, default: 'issue' })
  type: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'text' })
  content: string;

  /** 联系方式（选填，便于平台回访） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  contact: string | null;

  /** 0 待处理 / 1 已处理 */
  @Column({ type: 'tinyint', default: 0 })
  status: number;

  /** 平台回复内容 */
  @Column({ type: 'text', nullable: true })
  reply: string | null;

  @Column({ type: 'bigint', nullable: true })
  reply_admin_id: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  reply_admin_name: string | null;

  @Column({ type: 'datetime', nullable: true })
  replied_at: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}
