import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Device, Store } from '../../database/entities';
import { DeviceController } from './device.controller';
import { DeviceService } from './device.service';
import { OperationLogModule } from '../operation-log/operation-log.module';

@Module({
  imports: [TypeOrmModule.forFeature([Device, Store]), OperationLogModule],
  controllers: [DeviceController],
  providers: [DeviceService],
  exports: [DeviceService],
})
export class DeviceModule {}
