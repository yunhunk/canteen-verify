import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ConsumptionService } from './consumption.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';

class ConsumptionQueryDto {
  employeeId?: string;
  storeId?: string;
  startDate?: string;
  endDate?: string;
  page?: string;
  pageSize?: string;
}

/**
 * 消费记录 / 统计 / 导出
 *
 * 公司端与平台端共用 service，差别只在 companyId 来源：
 * - 公司端：取自 JWT，**不接受请求参数**（否则改 query 就能看别家数据）
 * - 平台端：可传 ?companyId= 聚焦某公司；不传则跨公司
 */
@Controller('api/company')
export class CompanyConsumptionController {
  constructor(private readonly consumptionService: ConsumptionService) {}

  @Get('consumptions')
  @Roles('company')
  list(@Query() q: ConsumptionQueryDto, @CurrentUser() user: JwtUser) {
    return this.consumptionService.query({
      companyId: user.companyId,
      employeeId: q.employeeId,
      storeId: q.storeId,
      startDate: q.startDate,
      endDate: q.endDate,
      page: Number(q.page),
      pageSize: Number(q.pageSize),
    });
  }

  @Get('consumptions/today')
  @Roles('company')
  today(@CurrentUser() user: JwtUser) {
    return this.consumptionService.todayCount(user.companyId).then((count) => ({ count }));
  }

  @Get('consumptions/trend')
  @Roles('company')
  trend(@Query('days') days?: string, @CurrentUser() user?: JwtUser) {
    return this.consumptionService.trend({
      companyId: user.companyId,
      days: Number(days) || 14,
    });
  }

  /**
   * 导出 CSV（UTF-8 BOM，Excel 直开不乱码）
   *
   * 直接在 controller 里写响应流：不走统一响应包装，
   * 否则 { code, message, data } 会被当成 CSV 内容导出去。
   */
  @Get('consumptions/export')
  @Roles('company')
  async export(@Query() q: ConsumptionQueryDto, @CurrentUser() user: JwtUser, @Res() res: Response) {
    const csv = await this.consumptionService.buildCsv({
      companyId: user.companyId,
      employeeId: q.employeeId,
      storeId: q.storeId,
      startDate: q.startDate,
      endDate: q.endDate,
    });
    this.writeCsv(res, csv, `consumptions-${this.stamp()}.csv`);
  }

  private writeCsv(res: Response, csv: string, filename: string) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.end(Buffer.from(csv, 'utf8'));
  }

  private stamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  }
}

@Controller('api/platform')
@Roles('super')
export class PlatformConsumptionController {
  constructor(private readonly consumptionService: ConsumptionService) {}

  @Get('consumptions')
  list(@Query() q: ConsumptionQueryDto & { companyId?: string }) {
    return this.consumptionService.query({
      companyId: q.companyId || null,
      employeeId: q.employeeId,
      storeId: q.storeId,
      startDate: q.startDate,
      endDate: q.endDate,
      page: Number(q.page),
      pageSize: Number(q.pageSize),
    });
  }

  @Get('consumptions/trend')
  trend(@Query('days') days?: string, @Query('companyId') companyId?: string) {
    return this.consumptionService.trend({
      companyId: companyId || null,
      days: Number(days) || 14,
    });
  }

  @Get('consumptions/export')
  async export(
    @Query() q: ConsumptionQueryDto & { companyId?: string },
    @Res() res: Response,
  ) {
    const csv = await this.consumptionService.buildCsv({
      companyId: q.companyId || null,
      employeeId: q.employeeId,
      storeId: q.storeId,
      startDate: q.startDate,
      endDate: q.endDate,
    });
    const d = new Date();
    const filename = `platform-consumptions-${d.getFullYear()}${String(d.getMonth() + 1).padStart(
      2,
      '0',
    )}${String(d.getDate()).padStart(2, '0')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.end(Buffer.from(csv, 'utf8'));
  }
}
