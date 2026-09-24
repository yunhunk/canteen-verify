import { Body, Controller, Post } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { VerifyService } from './verify.service';
import { Public } from '../common/decorators/roles.decorator';
import { toOperator } from '../common/types/operator';
import { ClientIp, CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { ToStrOptional } from '../common/dto/to-str.decorator';

class ScanVerifyDto {
  @IsString()
  @IsNotEmpty({ message: '缺少二维码凭证' })
  qrToken: string;

  @ToStrOptional() @IsOptional() storeId?: string;
}

class DeviceVerifyDto {
  /** 一机一密钥（推荐） */
  @IsOptional() @IsString() deviceKey?: string;

  /** 旧的全局密钥，仅用于平滑过渡 */
  @IsOptional() @IsString() deviceToken?: string;

  @IsString()
  @IsNotEmpty({ message: '缺少二维码凭证' })
  qrToken: string;

  @ToStrOptional() @IsOptional() storeId?: string;
}

@Controller('api')
export class VerifyController {
  constructor(private readonly verify: VerifyService) {}

  /**
   * 门店核销员扫码核销（员工端 JWT 鉴权）
   *
   * 与设备通道共用同一条核销链路 —— 业务规则（时段、扣减）只实现一次，
   * 避免两条通道行为不一致。
   */
  @Post('verify/scan')
  scan(
    @Body() dto: ScanVerifyDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.verify.verify({
      qrToken: dto.qrToken,
      storeId: dto.storeId ?? null,
      device: null,
      verifierId: user.uid,
      operator: toOperator(user),
      ip,
    });
  }

  /**
   * 扫码机器（扫码枪 / 闸机）专用
   *
   * 与用户 JWT 完全解耦：设备没有也不需要账号体系。
   * 用 @Public 跳过 JWT 守卫，鉴权完全由设备密钥承担。
   */
  @Public()
  @Post('device/verify')
  async deviceVerify(@Body() dto: DeviceVerifyDto, @ClientIp() ip: string | null) {
    const device = await this.verify.authenticateDevice(
      dto.deviceKey,
      dto.deviceToken,
      dto.storeId,
    );

    return this.verify.verify({
      qrToken: dto.qrToken,
      device,
      storeId: dto.storeId ?? null,
      verifierId: null,
      operator: {
        uid: null,
        name: device ? `设备:${device.name}` : '设备:legacy',
        role: 'device',
      },
      ip,
    });
  }
}
