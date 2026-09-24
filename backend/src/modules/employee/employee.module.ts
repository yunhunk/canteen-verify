import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company, Consumption, Employee, QrCode, Store, VerificationRule } from '../../database/entities';
import { CompanyEmployeeController, EmployeeController, PlatformEmployeeController } from './employee.controller';
import { EmployeeService } from './employee.service';
import { OperationLogModule } from '../operation-log/operation-log.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Employee, Company, Consumption, QrCode, Store, VerificationRule]),
    OperationLogModule,
  ],
  controllers: [EmployeeController, CompanyEmployeeController, PlatformEmployeeController],
  providers: [EmployeeService],
  exports: [EmployeeService],
})
export class EmployeeModule {}
