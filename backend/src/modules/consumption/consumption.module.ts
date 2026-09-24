import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company, Consumption, Employee, Store } from '../../database/entities';
import { CompanyConsumptionController, PlatformConsumptionController } from './consumption.controller';
import { ConsumptionService } from './consumption.service';

@Module({
  imports: [TypeOrmModule.forFeature([Consumption, Employee, Store, Company])],
  controllers: [CompanyConsumptionController, PlatformConsumptionController],
  providers: [ConsumptionService],
  exports: [ConsumptionService],
})
export class ConsumptionModule {}
