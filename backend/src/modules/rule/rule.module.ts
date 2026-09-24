import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company, VerificationRule } from '../../database/entities';
import { CompanyRuleController, PlatformRuleController } from './rule.controller';
import { RuleService } from './rule.service';
import { OperationLogModule } from '../operation-log/operation-log.module';

@Module({
  imports: [TypeOrmModule.forFeature([VerificationRule, Company]), OperationLogModule],
  controllers: [CompanyRuleController, PlatformRuleController],
  providers: [RuleService],
  exports: [RuleService],
})
export class RuleModule {}
