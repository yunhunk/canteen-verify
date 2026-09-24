import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Admin, Company, Employee } from '../../database/entities';
import { AuthController, EmployeeAuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OperationLogModule } from '../operation-log/operation-log.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RedisService } from '../common/redis.service';

@Module({
  imports: [TypeOrmModule.forFeature([Admin, Employee, Company]), OperationLogModule],
  controllers: [AuthController, EmployeeAuthController],
  providers: [AuthService, RedisService, JwtAuthGuard],
  exports: [AuthService],
})
export class AuthModule {}
