import { Body, Controller, Post } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { ClientIp } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/roles.decorator';

class AdminLoginDto {
  @IsString()
  @IsNotEmpty({ message: '请输入账号' })
  username: string;

  @IsString()
  @IsNotEmpty({ message: '请输入密码' })
  @MaxLength(72, { message: '密码长度不能超过 72 个字符' })
  password: string;
}

class EmployeeLoginDto {
  @IsString()
  @IsNotEmpty({ message: '缺少微信 code' })
  @Length(32, 32, { message: '微信 code 格式不正确' })
  code: string;

  /** 首次登录时用于匹配员工；已绑定 openid 时可不传 */
  @IsOptional()
  @IsString()
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
  phone?: string;

  @IsOptional()
  @IsString()
  employeeNo?: string;
}

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** 后台登录（公司 / 平台共用入口，按 role 分流） */
  @Public()
  @Post('admin/login')
  adminLogin(@Body() dto: AdminLoginDto, @ClientIp() ip: string | null) {
    return this.auth.adminLogin(dto.username, dto.password, ip);
  }

  /** 员工微信登录 / 绑定 */
  @Public()
  @Post('employee/login')
  employeeLogin(@Body() dto: EmployeeLoginDto) {
    return this.auth.employeeLogin(dto.code, dto.phone, dto.employeeNo);
  }
}

/** 员工端接口（按设计文档 5.2 的 /api/employee/* 路径） */
@Controller('api/employee')
export class EmployeeAuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: EmployeeLoginDto) {
    return this.auth.employeeLogin(dto.code, dto.phone, dto.employeeNo);
  }
}
