import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { CompanyService } from './company.service';
import { Roles } from '../common/decorators/roles.decorator';
import { toOperator } from '../common/types/operator';
import { ClientIp, CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { ToInt, ToIntOrNull, ToStrOptional } from '../common/dto/to-str.decorator';
import { MEAL_STANDARD_MAX } from '../common/utils/meal-standard';

class CreateCompanyDto {
  @IsString()
  @IsNotEmpty({ message: '公司名称不能为空' })
  name: string;

  @IsOptional() @IsString() contactName?: string;
  @IsOptional() @IsString() contactPhone?: string;

  @ToStrOptional() @IsOptional() planId?: string;

  @ToInt() @IsOptional() totalQuota?: number;
  @ToInt() @IsOptional() status?: number;

  /** 餐标（元）；不传 = 不设置 */
  @ToIntOrNull() @IsOptional() @IsNumber() @Min(0) @Max(MEAL_STANDARD_MAX)
  mealStandard?: number | null;
}

class UpdateCompanyDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() contactName?: string;
  @IsOptional() @IsString() contactPhone?: string;
  @ToStrOptional() @IsOptional() planId?: string;
  @ToInt() @IsOptional() totalQuota?: number;
  @ToInt() @IsOptional() remainQuota?: number;
  @ToInt() @IsOptional() status?: number;

  // 餐标刻意**不在这里**：改餐标走 PUT companies/:id/meal-standard。
  // 若允许它从通用编辑进来，同一件事就有两条路径、两种审计 action，
  // 排查「餐标什么时候被谁改的」时要同时看两处日志。
}

/**
 * 设置餐标（**平台端专用**）。
 *
 * 公司端没有对应接口：餐标由平台统一掌握，公司管理员只能查看。
 * 设置在类定义**之前**是必须的 —— 放到文件末尾会因为
 * `design:paramtypes` 元数据在类定义前求值而抛
 * `Cannot access 'SetMealStandardDto' before initialization`（TDZ）。
 * 这是**运行时**才炸的坑 —— `tsc --noEmit` 完全看不出来，
 * 只有真的把服务起起来才会暴露。
 */
class SetMealStandardDto {
  /**
   * 餐标（元）；`null` = 清除。
   *
   * ⚠️ 这里必须用 `@ValidateIf` 而不是 `@IsOptional()`：
   * - `null` 是**有效输入**（= 清除餐标），不能被当成"没传"放过；
   * - 真正没传字段时仍要 400，否则「清空餐标」和「忘了传」在后端看来一模一样。
   *
   * 而裸 `@IsNumber()` 会把 `null` 判为非法（null 不是 number），
   * 于是"清除餐标"会被 400 静默拦掉 —— 前端还以为改成功了。
   */
  @ToIntOrNull()
  @ValidateIf((o: SetMealStandardDto) => o.mealStandard !== null)
  @IsNumber({}, { message: '餐标必须是数字' })
  @Min(0, { message: '餐标不能为负数' })
  @Max(MEAL_STANDARD_MAX, { message: `餐标不能超过 ${MEAL_STANDARD_MAX} 元` })
  mealStandard: number | null;
}

/**
 * 平台总后台 · 公司管理
 */
@Controller('api/platform')
@Roles('super')
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  /**
   * 公司列表。
   *
   * 返回结构与 /api/platform/employees 保持一致（{ total, page, pageSize, list }），
   * 前端 useList() 只认这一种结构 —— 早期这里直接 return 裸数组，
   * 导致管理后台「公司管理」页永远显示「共 0 家公司 / 暂无数据」。
   * 分页在内存里做：公司数量是租户量级（几十~几百），不值得为它多写一套 SQL 分页。
   */
  @Get('companies')
  async list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    const all = await this.companyService.listAll();
    const kw = (keyword || '').trim();
    const filtered = kw
      ? all.filter(
          (c) =>
            c.name.includes(kw) ||
            (c.contactName || '').includes(kw) ||
            (c.contactPhone || '').includes(kw),
        )
      : all;

    const p = Math.max(1, Number(page) || 1);
    const ps = Math.max(1, Number(pageSize) || 20);
    const start = (p - 1) * ps;

    return {
      total: filtered.length,
      page: p,
      pageSize: ps,
      list: filtered.slice(start, start + ps),
    };
  }

  @Get('statistics')
  statistics() {
    return this.companyService.platformStatistics();
  }

  @Post('companies')
  create(
    @Body() dto: CreateCompanyDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.companyService.create(dto, toOperator(user), ip);
  }

  @Put('companies/:id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCompanyDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.companyService.update(id, dto, toOperator(user), ip);
  }

  /**
   * 设置 / 清除公司餐标。
   *
   * 餐标是**平台级**配置：公司管理员只看得见、改不了
   * （公司端只保留了 GET company/settings）。
   * 理由是餐标决定了核销机器对外播报的「这顿饭值多少钱」——
   * 口径得由平台统一，否则各家自报一个数，对账和客诉时都说不清。
   *
   * body 里 `mealStandard` 传 `null` = 清除（播报退回只说「核销成功」）。
   */
  @Put('companies/:id/meal-standard')
  setMealStandard(
    @Param('id') id: string,
    @Body() dto: SetMealStandardDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.companyService.setMealStandard(
      id,
      dto.mealStandard ?? null,
      toOperator(user),
      ip,
    );
  }
}

/**
 * 公司端 / 平台端共用的公司概览
 */
@Controller('api')
export class CompanyOverviewController {
  constructor(private readonly companyService: CompanyService) {}

  /** 公司端看板：companyId 取自 JWT */
  @Get('company/statistics')
  @Roles('company')
  companyStatistics(@CurrentUser() user: JwtUser) {
    return this.companyService.companyStatistics(user.companyId);
  }

  /** 本公司剩余次数（员工端首页不再展示，但保留接口给其他端用） */
  @Get('company/remain')
  async remain(@CurrentUser() user: JwtUser) {
    const stat = await this.companyService.companyStatistics(user.companyId);
    return {
      companyId: stat.companyId,
      companyName: stat.companyName,
      remainQuota: stat.remainQuota,
      totalQuota: stat.totalQuota,
    };
  }

  /**
   * 公司设置（**只读**）。
   *
   * companyId 一律取自 JWT —— 公司管理员只能看自己公司，
   * 不存在「传个 id 就能看别家」的口子。
   *
   * 这里刻意只有 GET：餐标由平台管理员统一设置
   * （见 PUT /api/platform/companies/:id/meal-standard）。
   * 公司端原本有一个写接口，现已下线 —— 管理员看得到当前值，
   * 要改就得找平台，避免各公司自行改口径。
   *
   * 档位仍然下发：管理员据此知道有哪些档，沟通时能和平台说同一个数
   * （「帮我调到 18 元档」），而不是描述成「比 15 多一点」。
   */
  @Get('company/settings')
  @Roles('company')
  getSettings(@CurrentUser() user: JwtUser) {
    return this.companyService.getSettings(user.companyId);
  }
}
