import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Consumption, Employee, QrCode, VerificationRule } from '../../database/entities';
import { QrcodeController } from './qrcode.controller';
import { QrcodeService } from './qrcode.service';
import { RedisService } from '../common/redis.service';
import { RuleModule } from '../rule/rule.module';

@Module({
  // RuleModule 用于「不在可核销时段不发码」—— 出码前先过一遍时段规则。
  // RuleModule 只导出 RuleService，与 QrcodeModule 无循环依赖。
  // Consumption/VerificationRule：状态查询接口反查「已核销（套餐档）」用。
  imports: [
    TypeOrmModule.forFeature([QrCode, Employee, Consumption, VerificationRule]),
    RuleModule,
  ],
  controllers: [QrcodeController],
  providers: [QrcodeService, RedisService],
  exports: [QrcodeService],
})
export class QrcodeModule {}
