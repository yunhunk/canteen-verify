import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { FeedbackService, FEEDBACK_TYPES } from './feedback.service';
import { Roles } from '../common/decorators/roles.decorator';
import { toOperator } from '../common/types/operator';
import { ClientIp, CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { ToInt, ToStr } from '../common/dto/to-str.decorator';

class SubmitFeedbackDto {
  @IsOptional() @IsIn(FEEDBACK_TYPES as unknown as string[])
  type?: string;

  @IsString()
  @IsNotEmpty({ message: '请填写标题' })
  @MaxLength(200, { message: '标题最多 200 字' })
  title: string;

  @IsString()
  @IsNotEmpty({ message: '请填写反馈内容' })
  @MaxLength(2000, { message: '内容最多 2000 字' })
  content: string;

  @IsOptional() @IsString() @MaxLength(50)
  contact?: string;
}

class ReplyFeedbackDto {
  @IsString()
  @IsNotEmpty({ message: '回复内容不能为空' })
  @MaxLength(1000, { message: '回复最多 1000 字' })
  reply: string;
}

class SetFeedbackStatusDto {
  @ToInt() @IsInt() @Min(0) @Max(1) status: number;
}

/**
 * 员工端 · 反馈
 */
@Controller('api/employee/feedbacks')
@Roles('employee')
export class EmployeeFeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /** 提交反馈 —— companyId 取自 JWT，不接受客户端传入 */
  @Post()
  submit(@Body() dto: SubmitFeedbackDto, @CurrentUser() user: JwtUser) {
    return this.feedback.submit(user.uid, user.companyId, dto);
  }

  /** 我的反馈历史 */
  @Get()
  mine(
    @CurrentUser() user: JwtUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.feedback.myFeedbacks(user.uid, Number(page), Number(pageSize));
  }
}

/**
 * 平台总后台 · 反馈管理
 *
 * ⚠️ 只挂 @Roles('super')：公司管理员**看不到**本公司员工的反馈。
 * 「公司能不能看」这件事不是靠前端隐藏菜单实现的 ——
 * 后端压根没有给公司的反馈接口，猜 URL 也只会拿到 403。
 */
@Controller('api/platform/feedbacks')
@Roles('super')
export class PlatformFeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /** 待处理数量（菜单角标） */
  @Get('pending-count')
  pendingCount() {
    return this.feedback.pendingCount();
  }

  /** 列表：分页 + 按公司/类型/状态/关键词筛选 */
  @Get()
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('companyId') companyId?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('keyword') keyword?: string,
  ) {
    return this.feedback.query({
      page: Number(page),
      pageSize: Number(pageSize),
      companyId: companyId || undefined,
      type: type || undefined,
      status: status === undefined || status === '' ? undefined : Number(status),
      keyword: keyword || undefined,
    });
  }

  @Get(':id')
  @Roles('super')
  detail(@Param('id') id: string) {
    return this.feedback.findOne(id);
  }

  /** 回复（顺带置为已处理） */
  @Put(':id/reply')
  reply(
    @Param('id') id: string,
    @Body() dto: ReplyFeedbackDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.feedback.reply(id, dto.reply, toOperator(user), ip);
  }

  /** 仅改状态 */
  @Put(':id/status')
  setStatus(
    @Param('id') id: string,
    @Body() dto: SetFeedbackStatusDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.feedback.setStatus(id, dto.status, toOperator(user), ip);
  }
}
