import { Admin } from './admin.entity';
import { Company } from './company.entity';
import { Consumption } from './consumption.entity';
import { Device } from './device.entity';
import { Employee } from './employee.entity';
import { Feedback } from './feedback.entity';
import { OperationLog } from './operation-log.entity';
import { Plan } from './plan.entity';
import { QrCode } from './qr-code.entity';
import { Store } from './store.entity';
import { VerificationRule } from './verification-rule.entity';

export {
  Admin,
  Company,
  Consumption,
  Device,
  Employee,
  Feedback,
  OperationLog,
  Plan,
  QrCode,
  Store,
  VerificationRule,
};

/** 11 张业务表 —— check:schema 与数据源注册共用这一份清单 */
export const ENTITIES = [
  Company,
  Plan,
  Employee,
  Consumption,
  QrCode,
  Store,
  Admin,
  Device,
  VerificationRule,
  OperationLog,
  Feedback,
];
