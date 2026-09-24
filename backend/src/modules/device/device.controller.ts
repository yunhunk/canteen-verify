import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { DeviceService } from './device.service';
import { Roles } from '../common/decorators/roles.decorator';
import { toOperator } from '../common/types/operator';
import { ClientIp, CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { ToInt, ToStrOptional } from '../common/dto/to-str.decorator';

class CreateDeviceDto {
  @IsString() @IsNotEmpty({ message: '设备名称不能为空' })
  name: string;

  @ToStrOptional() @IsOptional() storeId?: string;
  @ToStrOptional() @IsOptional() companyId?: string;
}

class UpdateDeviceDto {
  @IsOptional() @IsString() name?: string;
  @ToStrOptional() @IsOptional() storeId?: string;
  @ToStrOptional() @IsOptional() companyId?: string;
  @ToInt() @IsOptional() @Min(0) @Max(1) status?: number;
}

/**
 * 核销设备管理（扫码枪 / 闸机）
 *
 * 一机一密钥；明文密钥仅在创建与换发时返回一次。
 * 列表接口只返回 keyPrefix，**绝不返回 key_hash**。
 */
@Controller('api/platform/devices')
@Roles('super')
export class DeviceController {
  constructor(private readonly deviceService: DeviceService) {}

  /**
   * 设备列表。
   *
   * 返回**裸数组**：平台端 Devices.vue 不走 useList，而是
   * `list.value = await deviceApi.list() || []`；改成 {list,total} 会渲染错。
   * 设备量级小（几十台），无需分页。
   */
  @Get()
  list() {
    return this.deviceService.listAll();
  }

  @Post()
  create(
    @Body() dto: CreateDeviceDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.deviceService.create(dto, toOperator(user), ip);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDeviceDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.deviceService.update(id, dto, toOperator(user), ip);
  }

  @Put(':id/status')
  setStatus(
    @Param('id') id: string,
    @Body() dto: { status: number },
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.deviceService.update(id, { status: Number(dto.status) }, toOperator(user), ip);
  }

  /** 换发密钥：旧密钥立即失效（key_hash 被覆盖，天然失效） */
  @Post(':id/rotate-key')
  rotateKey(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.deviceService.rotateKey(id, toOperator(user), ip);
  }
}
