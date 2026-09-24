import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Plan } from '../../database/entities';
import { PlanController } from './plan.controller';
import { PlanService } from './plan.service';
import { OperationLogModule } from '../operation-log/operation-log.module';

@Module({
  imports: [TypeOrmModule.forFeature([Plan]), OperationLogModule],
  controllers: [PlanController],
  providers: [PlanService],
  exports: [PlanService],
})
export class PlanModule {}
