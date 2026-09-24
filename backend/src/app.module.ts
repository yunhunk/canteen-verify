import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from './config/config.module';
import { APP_CONFIG, AppConfig, buildDataSourceOptions } from './config/app.config';
import { ENTITIES, Admin, Employee } from './database/entities';

// 业务模块
import { AuthModule } from './modules/auth/auth.module';
import { CompanyModule } from './modules/company/company.module';
import { PlanModule } from './modules/plan/plan.module';
import { EmployeeModule } from './modules/employee/employee.module';
import { QrcodeModule } from './modules/qrcode/qrcode.module';
import { VerifyModule } from './modules/verify/verify.module';
import { ConsumptionModule } from './modules/consumption/consumption.module';
import { AdminModule } from './modules/admin/admin.module';
import { StoreModule } from './modules/store/store.module';
import { DeviceModule } from './modules/device/device.module';
import { RuleModule } from './modules/rule/rule.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { OperationLogModule } from './modules/operation-log/operation-log.module';

// 全局横切
import { JwtAuthGuard } from './modules/common/guards/jwt-auth.guard';
import { RolesGuard } from './modules/common/guards/roles.guard';
import { TenantGuard } from './modules/common/guards/tenant.guard';
import { AllExceptionsFilter } from './modules/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './modules/common/interceptors/response.interceptor';
import { RedisService } from './modules/common/redis.service';

@Module({
  imports: [
    ConfigModule,

    // 数据源：本地模式 SQLite(WASM)，生产 MySQL
    TypeOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildDataSourceOptions(config) as any,
    }),
    // JwtAuthGuard 是全局守卫，两个仓储都要在这里可解析：
    // Admin 用于后台角色吊销，Employee 用于员工端 token_version 校验
    TypeOrmModule.forFeature([Admin, Employee]),

    // JWT：全局注册，各模块可直接注入 JwtService
    JwtModule.registerAsync({
      global: true,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        secret: config.jwtSecret,
        signOptions: { expiresIn: config.jwtExpiresIn },
      }),
    }),

    AuthModule,
    CompanyModule,
    PlanModule,
    EmployeeModule,
    QrcodeModule,
    VerifyModule,
    ConsumptionModule,
    AdminModule,
    StoreModule,
    DeviceModule,
    RuleModule,
    FeedbackModule,
    OperationLogModule,
  ],
  providers: [
    RedisService,
    // 守卫顺序即注册顺序：先验身份 → 再验角色 → 最后验租户
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule {}
