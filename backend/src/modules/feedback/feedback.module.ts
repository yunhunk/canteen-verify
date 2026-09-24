import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company, Employee, Feedback } from '../../database/entities';
import {
  EmployeeFeedbackController,
  PlatformFeedbackController,
} from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { OperationLogModule } from '../operation-log/operation-log.module';

@Module({
  imports: [TypeOrmModule.forFeature([Feedback, Employee, Company]), OperationLogModule],
  controllers: [EmployeeFeedbackController, PlatformFeedbackController],
  providers: [FeedbackService],
  exports: [FeedbackService],
})
export class FeedbackModule {}
