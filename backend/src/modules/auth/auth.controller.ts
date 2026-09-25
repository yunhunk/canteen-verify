import { Body, Controller, Post } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { AuthService } from './auth.service';
import { ClientIp, CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { Public, Roles } from '../common/decorators/roles.decorator';
import { toOperator } from '../common/types/operator';

class AdminLoginDto {
  @IsString()
  @IsNotEmpty({ message: '请输入账号' })
  @MaxLength(64, { message: '账号长度不能超过 64 个字符' })
  username: string;

  @IsString()
  @IsNotEmpty({ message: '请输入密码' })
  @MaxLength(72, { message: '密码长度不能超过 72 个字符' })
  password: string;
}

class EmployeeLoginDto {
  @IsString()
  @IsNotEmpty({ message: '缺少微信 code' })
  // 微信 code 实测长度约 32 字符，但为兼容本地 mock 与未来变更，
  // 只做宽松上下界（1~128），拒绝超长 payload 即可 —— 过严的定长会
  // 把合法的本地联调请求误杀（教训：曾用 32,32 挡掉 mock code）。
  @Length(1, 128, { message: '微信 code 格式不正确' })
  code: string;

  /** 首次登录时用于匹配员工；已绑定 openid 时可不传 */
  @IsOptional()
  @IsString()
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
  phone?: string;

  /**
   * 工号：仅作为辅助校验，**不能单独用作身份凭据**。
   *
   * 原因：employee_no 跨公司不唯一（A0001 在多家公司都存在），
   * 且值是短小可枚举的，单凭它绑定会形成跨租户越权绑定的入口。
   * 服务端要求必须与 phone 同时命中同一行才放行。
   */
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '工号长度不能超过 50 个字符' })
  @Matches(/^[A-Za-z0-9-]{1,50}$/, { message: '工号格式不正确' })
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

  /**
   * 员工微信登录 / 绑定
   *
   * 与 /api/employee/login 是同一个实现 —— 两条路由并存属于历史遗留。
   * 安全加固必须落在 AuthService.employeeLogin 内部（限流、原子绑定、
   * 统一错误文案），否则只修一条路由会让另一条仍可被利用。
   */
  @Public()
  @Post('employee/login')
  employeeLogin(@Body() dto: EmployeeLoginDto, @ClientIp() ip: string | null) {
    return this.auth.employeeLogin(dto.code, dto.phone, dto.employeeNo, ip);
  }

  /**
   * 服务端登出：递增 token_version，使已签发的 JWT 立即失效。
   *
   * ## 为什么需要它
   *
   * JWT 是无状态的，默认 7 天有效。原来登出只在客户端清 localStorage，
   * 服务器毫不知情 —— 令牌若已被窃取（XSS / 共享终端 / 代理日志），
   * 在剩余有效期内仍可继续调用 API，受害者无法自救。
   *
   * 复用既有的 token_version 机制（JwtAuthGuard 每请求比对 payload.tv），
   * 一次自增即可让当前令牌作废，无需引入黑名单等新基础设施。
   */
  @Post('logout')
  @Roles('super', 'company', 'employee')
  logout(@CurrentUser() user: JwtUser, @ClientIp() ip: string | null) {
    return this.auth.logout(user, ip);
  }
}

/** 员工端接口（按设计文档 5.2 的 /api/employee/* 路径） */
@Controller('api/employee')
export class EmployeeAuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: EmployeeLoginDto, @ClientIp() ip: string | null) {
    return this.auth.employeeLogin(dto.code, dto.phone, dto.employeeNo, ip);
  }
}
