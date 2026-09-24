import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { RuleService } from './rule.service';
import { Roles } from '../common/decorators/roles.decorator';
import { toOperator } from '../common/types/operator';
import { ClientIp, CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { ToInt, ToStrOptional } from '../common/dto/to-str.decorator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

class CreateRuleDto {
  @IsString() @IsNotEmpty({ message: '时段名称不能为空' })
  name: string;

  @IsString() @Matches(HHMM, { message: '开始时间格式应为 HH:mm（如 11:00）' })
  startTime: string;

  @IsString() @Matches(HHMM, { message: '结束时间格式应为 HH:mm（如 13:30）' })
  endTime: string;

  /** 0 = 不限 */
  @ToInt() @IsOptional() @Min(0) @Max(99) perEmployeeLimit?: number;
  @ToInt() @IsOptional() @Min(0) @Max(1) status?: number;
}

class UpdateRuleDto extends CreateRuleDto {
  @IsOptional() @IsString() name: string;
  @IsOptional() @IsString() startTime: string;
  @IsOptional() @IsString() endTime: string;
}

class SetRuleStatusDto {
  @ToInt() @IsInt() @Min(0) @Max(1) status: number;
}

/**
 * 公司端的核销时段规则 —— 公司自助配置
 */
@Controller('api/company/rules')
@Roles('company')
export class CompanyRuleController {
  constructor(private readonly ruleService: RuleService) {}

  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.ruleService.listByCompany(user.companyId);
  }

  @Post()
  create(
    @Body() dto: CreateRuleDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.ruleService.create(user.companyId, dto, toOperator(user), ip);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRuleDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.ruleService.update(id, dto, { companyId: user.companyId, isSuper: false }, toOperator(user), ip);
  }

  @Put(':id/status')
  setStatus(
    @Param('id') id: string,
    @Body() dto: SetRuleStatusDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.ruleService.setStatus(
      id,
      dto.status,
      { companyId: user.companyId, isSuper: false },
      user,
      ip,
    );
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.ruleService.remove(id, { companyId: user.companyId, isSuper: false }, toOperator(user), ip);
  }
}

/**
 * 平台端代管任意公司的时段规则
 *
 * 与公司端分两个 controller：平台端必须显式带 companyId，
 * 且 service 层额外校验租户归属（跨租户返回 403）。
 */
@Controller('api/platform/rules')
@Roles('super')
export class PlatformRuleController {
  constructor(private readonly ruleService: RuleService) {}

  /**
   * 平台端规则列表。
   *
   * companyId 必传（规则天然归属某家公司，不传 = 无从查起，返回空列表）。
   * 返回**裸数组**：平台端 Rules.vue 不走 useList，而是直接
   * `list.value = await api.list(...)`，改成 {list,total} 反而会渲染错。
   * 规则条数本来就少（一家公司几条），不需要分页。
   */
  @Get()
  list(@Query('companyId') companyId: string) {
    if (!companyId) return [];
    return this.ruleService.listByCompany(companyId);
  }

  @Post()
  create(
    @Body() dto: CreateRuleDto & { companyId: string },
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.ruleService.create(dto.companyId, dto, toOperator(user), ip);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRuleDto & { companyId?: string },
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.ruleService.update(id, dto, { companyId: null, isSuper: true }, toOperator(user), ip);
  }

  @Put(':id/status')
  setStatus(
    @Param('id') id: string,
    @Body() dto: SetRuleStatusDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.ruleService.setStatus(id, dto.status, { companyId: null, isSuper: true }, toOperator(user), ip);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.ruleService.remove(id, { companyId: null, isSuper: true }, toOperator(user), ip);
  }
}
