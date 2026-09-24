import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OperationLog } from '../../database/entities';
import { OperationLogService } from './operation-log.service';
import { CompanyLogController, PlatformLogController } from './operation-log.controller';

@Module({
  imports: [TypeOrmModule.forFeature([OperationLog])],
  controllers: [CompanyLogController, PlatformLogController],
  providers: [OperationLogService],
  exports: [OperationLogService],
})
export class OperationLogModule {}
