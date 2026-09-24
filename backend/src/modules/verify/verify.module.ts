import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Company,
  Consumption,
  Device,
  Employee,
  QrCode,
  Store,
  VerificationRule,
} from '../../database/entities';
import { VerifyController } from './verify.controller';
import { VerifyService } from './verify.service';
import { OperationLogModule } from '../operation-log/operation-log.module';
import { RedisService } from '../common/redis.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Company,
      Employee,
      QrCode,
      Device,
      Store,
      Consumption,
      VerificationRule,
    ]),
    OperationLogModule,
  ],
  controllers: [VerifyController],
  providers: [VerifyService, RedisService],
  exports: [VerifyService],
})
export class VerifyModule {}
