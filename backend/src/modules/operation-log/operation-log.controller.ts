import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { OperationLogService } from './operation-log.service';

class LogQueryDto {
  module?: string;
  action?: string;
  startDate?: string;
  endDate?: string;
  page?: string;
  pageSize?: string;
  /** 仅平台端有效：聚焦某公司；传 __PLATFORM__ 查平台级操作 */
  companyId?: string;
}

/**
 * 公司端操作日志
 *
 * 强制以 JWT 的 companyId 过滤 —— **不接受请求参数传入 companyId**。
 * 这不是「多一层校验」，而是唯一正确的实现：一旦允许请求传参，
 * 任何公司管理员改一下 query string 就能读到别家的操作记录。
 */
@Controller('api/company/operation-logs')
export class CompanyLogController {
  constructor(private readonly logs: OperationLogService) {}

  @Get()
  @Roles('company')
  list(@Query() q: LogQueryDto, @CurrentUser() user: JwtUser) {
    return this.logs.query({
      companyId: user.companyId, // 取自 JWT，非请求参数
      module: q.module,
      action: q.action,
      startDate: q.startDate,
      endDate: q.endDate,
      page: Number(q.page),
      pageSize: Number(q.pageSize),
    });
  }
}

/**
 * 平台端操作日志
 *
 * 与公司端分两个 controller：语义不同（租户隔离 vs 跨公司），
 * URL 形态也不同（公司端不带 companyId、平台端可带），合并会牺牲清晰度。
 */
@Controller('api/platform/operation-logs')
export class PlatformLogController {
  constructor(private readonly logs: OperationLogService) {}

  @Get()
  @Roles('super')
  list(@Query() q: LogQueryDto) {
    return this.logs.query({
      companyId: q.companyId === undefined ? undefined : q.companyId,
      module: q.module,
      action: q.action,
      startDate: q.startDate,
      endDate: q.endDate,
      page: Number(q.page),
      pageSize: Number(q.pageSize),
    });
  }
}
