import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { QrcodeService } from './qrcode.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { ToStrOptional } from '../common/dto/to-str.decorator';

class IssueDto {
  /** 员工代扫场景：核销员扫的是别人的码，出码方仍是本人，无需额外参数 */
  @IsOptional() @IsString() remark?: string;
}

@Controller('api')
export class QrcodeController {
  constructor(private readonly qrcode: QrcodeService) {}

  /**
   * 获取 / 刷新我的核销二维码
   *
   * 每次调用都作废上一个动态码，避免小程序反复刷新时
   * 在库里堆出一堆仍可用的活码。
   */
  @Get('employee/qrcode')
  @Roles('employee')
  issue(@CurrentUser() user: JwtUser, @Body() _dto?: IssueDto) {
    return this.qrcode.issue(user.uid, user.companyId);
  }

  @Post('employee/qrcode')
  @Roles('employee')
  issuePost(@CurrentUser() user: JwtUser) {
    return this.qrcode.issue(user.uid, user.companyId);
  }

  /**
   * 我的当前码状态（小程序核销页轮询）。
   *
   * 轮询而非推送：员工端没有可靠的推送通道，2 秒一次的轻查询
   * （走 employee_id+type 索引）已经能让「已核销」在 2 秒内出现在占位区，
   * 足够员工在窗口前感知到"扫上了"。
   */
  @Get('employee/qrcode/status')
  @Roles('employee')
  status(@CurrentUser() user: JwtUser) {
    return this.qrcode.getStatus(user.uid);
  }
}
