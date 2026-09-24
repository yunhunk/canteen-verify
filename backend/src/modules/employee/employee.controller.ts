import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EmployeeService } from './employee.service';
import { Roles } from '../common/decorators/roles.decorator';
import { toOperator } from '../common/types/operator';
import { ClientIp, CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { ToBool, ToInt, ToIntOrNull, ToStrOptional } from '../common/dto/to-str.decorator';

class SetStatusDto {
  @IsInt({ message: 'status 必须是整数' })
  @Min(0)
  @Max(1)
  status: number;
}

class CreateEmployeeDto {
  @ToStrOptional() @IsString() @IsNotEmpty({ message: '缺少所属公司' })
  companyId: string;

  @IsString() @IsNotEmpty({ message: '姓名不能为空' })
  name: string;

  @IsString() @IsNotEmpty({ message: '手机号不能为空' })
  phone: string;

  @IsOptional() @IsString() employeeNo?: string;
  @ToInt() @IsOptional() status?: number;
}

class UpdateEmployeeDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() employeeNo?: string;
  @ToStrOptional() @IsOptional() companyId?: string;
  @ToInt() @IsOptional() status?: number;
  /** 员工核销次数：null = 不限制；不传 = 不改动 */
  @ToIntOrNull()
  @IsOptional()
  @IsInt({ message: '核销次数必须是整数' })
  @Min(0, { message: '核销次数不能为负数' })
  @Max(100000, { message: '核销次数不能超过 100000' })
  quotaTotal?: number | null;
}

/**
 * 设置员工核销次数。
 *
 * `quotaTotal` 的三种取值语义完全不同，不能混：
 * - `null`     → 不限制（公司不控这个人的次数）
 * - `0`        → 一次都不允许
 * - 正整数     → 具体剩余次数
 * 所以用 `@ToIntOrNull()` 而非 `@ToInt()`（后者会把 null 吞成 undefined）。
 */
class SetQuotaDto {
  @ToIntOrNull()
  @IsOptional()
  @IsInt({ message: '核销次数必须是整数' })
  @Min(0, { message: '核销次数不能为负数' })
  @Max(100000, { message: '核销次数不能超过 100000' })
  quotaTotal: number | null;

  /** 是否把「已用次数」清零（重新发一轮额度时用） */
  @ToBool() @IsOptional() @IsBoolean() resetUsed?: boolean;
}

class BatchQuotaDto {
  @IsArray()
  @ArrayMaxSize(500, { message: '单次最多设置 500 人' })
  employeeIds: string[];

  @ToIntOrNull()
  @IsOptional()
  @IsInt({ message: '核销次数必须是整数' })
  @Min(0, { message: '核销次数不能为负数' })
  @Max(100000, { message: '核销次数不能超过 100000' })
  quotaTotal: number | null;
}

class BatchRowDto {
  @ToStrOptional() @IsString() @IsNotEmpty({ message: '缺少所属公司' }) companyId: string;
  @IsString() @IsNotEmpty() name: string;
  @IsString() @IsNotEmpty() phone: string;
  @IsOptional() @IsString() employeeNo?: string;
}

class BatchImportDto {
  @IsArray()
  @ArrayMaxSize(2000, { message: '单次导入不能超过 2000 行' })
  @ValidateNested({ each: true })
  @Type(() => BatchRowDto)
  rows: BatchRowDto[];
}

/**
 * 公司后台 · 员工管理
 *
 * 公司端 **只有查看 + 停用/启用**，没有增删 —— 员工增删接口仅 super 可访问。
 */
@Controller('api/company')
export class CompanyEmployeeController {
  constructor(private readonly employeeService: EmployeeService) {}

  @Get('employees')
  @Roles('company')
  list(
    @CurrentUser() user: JwtUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('status') status?: string,
  ) {
    return this.employeeService.listByCompany(user.companyId, {
      page: Number(page),
      pageSize: Number(pageSize),
      keyword,
      status: status === undefined || status === '' ? undefined : Number(status),
    });
  }

  /** 公司端唯一的写操作 */
  @Put('employees/:id/status')
  @Roles('company')
  setStatus(
    @Param('id') id: string,
    @Body() dto: SetStatusDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.employeeService.setStatus(
      id,
      dto.status,
      { companyId: user.companyId, isSuper: false },
      user,
      ip,
    );
  }

  /** 设置单个员工的剩余核销次数（quotaTotal 传 null 表示不限制） */
  @Put('employees/:id/quota')
  @Roles('company')
  setQuota(
    @Param('id') id: string,
    @Body() dto: SetQuotaDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.employeeService.setQuota(
      id,
      dto.quotaTotal,
      { resetUsed: !!dto.resetUsed },
      { companyId: user.companyId, isSuper: false },
      user,
      ip,
    );
  }

  /** 批量设置员工剩余核销次数（勾选多人统一设置） */
  @Post('employees/quota/batch')
  @Roles('company')
  batchSetQuota(
    @Body() dto: BatchQuotaDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.employeeService.batchSetQuota(
      dto.employeeIds || [],
      dto.quotaTotal,
      { companyId: user.companyId, isSuper: false },
      user,
      ip,
    );
  }

  /**
   * 解绑员工微信（公司端第二个写操作）。
   *
   * 必须给公司端：员工换微信后，新微信登录会被「已绑定其他微信」拦住，
   * 只有管理员能解开这个绑定。不开放这个按钮，客户就只能走工单
   * 找平台改库 —— 而这是换手机这种再普通不过的事。
   *
   * 注意它**不等于停用**：不动额度、不动状态、不动历史记录，
   * 只解除微信关联并让该员工重新登录。
   */
  @Post('employees/:id/unbind-wechat')
  @Roles('company')
  unbindWechat(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.employeeService.unbindWechat(
      id,
      { companyId: user.companyId, isSuper: false },
      user,
      ip,
    );
  }
}

/**
 * 平台总后台 · 员工管理（含增删改 + 批量导入）
 */
@Controller('api/platform')
@Roles('super')
export class PlatformEmployeeController {
  constructor(private readonly employeeService: EmployeeService) {}

  @Get('employees')
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('companyId') companyId?: string,
    @Query('status') status?: string,
  ) {
    return this.employeeService.listAll({
      page: Number(page),
      pageSize: Number(pageSize),
      keyword,
      companyId: companyId || undefined,
      status: status === undefined || status === '' ? undefined : Number(status),
    });
  }

  @Post('employees')
  create(
    @Body() dto: CreateEmployeeDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.employeeService.create(dto, toOperator(user), ip);
  }

  /**
   * 批量导入：逐行校验，个别行失败不回滚整批。
   * 运营拿到 500 人的表，不能因为第 3 行重复就整批退回。
   */
  @Post('employees/batch')
  batch(
    @Body() dto: BatchImportDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.employeeService.batchImport(dto.rows || [], toOperator(user), ip);
  }

  @Put('employees/:id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.employeeService.update(id, dto, toOperator(user), ip);
  }

  /** 停用员工（逻辑删除，保留核销记录用于对账） */
  @Put('employees/:id/status')
  setStatus(
    @Param('id') id: string,
    @Body() dto: SetStatusDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.employeeService.setStatus(
      id,
      dto.status,
      { companyId: null, isSuper: true },
      user,
      ip,
    );
  }

  /** 解绑员工微信（平台侧可跨公司操作，会同时作废其未用二维码并吊销登录态） */
  @Post('employees/:id/unbind-wechat')
  unbindWechat(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.employeeService.unbindWechat(
      id,
      { companyId: null, isSuper: true },
      toOperator(user),
      ip,
    );
  }
}

/**
 * 员工端接口（小程序）
 *
 * 所有接口都以 JWT 中的 uid 为准取数据 —— 不接受请求传入 employeeId，
 * 否则任何员工都能拿到别人的消费记录。
 */
@Controller('api/employee')
export class EmployeeController {
  constructor(private readonly employeeService: EmployeeService) {}

  @Get('me')
  @Roles('employee')
  me(@CurrentUser() user: JwtUser) {
    return this.employeeService.me(user.uid);
  }

  @Get('statistics')
  @Roles('employee')
  statistics(@CurrentUser() user: JwtUser) {
    return this.employeeService.myStatistics(user.uid);
  }

  @Get('consumptions')
  @Roles('employee')
  consumptions(
    @CurrentUser() user: JwtUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.employeeService.myConsumptions(user.uid, Number(page), Number(pageSize));
  }

  /**
   * 今日可核销时段 + 当前是否开放 + 本人额度/餐标。
   *
   * 一次请求给全核销页需要的东西：在不在时段、还有没有次数、餐标多少。
   * 拦截始终以核销时服务端判定为准，这里只是界面提示。
   */
  @Get('windows')
  async windows(@CurrentUser() user: JwtUser) {
    const [win, quota] = await Promise.all([
      // 带上 employeeId：首页/核销页要展示「今日还可 N 次」
      this.employeeService.isOpenNow(user.companyId, user.uid),
      this.employeeService.myQuota(user.uid),
    ]);
    return { ...win, ...quota };
  }
}
