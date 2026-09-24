import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company, Consumption, Employee, Plan, Store } from '../../database/entities';
import { CompanyController, CompanyOverviewController } from './company.controller';
import { CompanyService } from './company.service';
import { OperationLogModule } from '../operation-log/operation-log.module';

@Module({
  imports: [TypeOrmModule.forFeature([Company, Employee, Consumption, Plan, Store]), OperationLogModule],
  controllers: [CompanyController, CompanyOverviewController],
  providers: [CompanyService],
  exports: [CompanyService],
})
export class CompanyModule {}
