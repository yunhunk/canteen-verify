import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { StoreService } from './store.service';
import { Roles } from '../common/decorators/roles.decorator';
import { toOperator } from '../common/types/operator';
import { ClientIp, CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { ToInt, ToStrOptional } from '../common/dto/to-str.decorator';

class CreateStoreDto {
  @IsString() @IsNotEmpty({ message: '门店名称不能为空' })
  name: string;

  @ToStrOptional() @IsOptional() companyId?: string;
}

class UpdateStoreDto {
  @IsOptional() @IsString() name?: string;
  @ToInt() @IsOptional() @Min(0) @Max(1) status?: number;
}

/** 门店管理：平台端专属，作为设备绑定下拉的数据源 */
@Controller('api/platform/stores')
@Roles('super')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  @Get()
  list() {
    return this.storeService.listAll();
  }

  @Post()
  create(
    @Body() dto: CreateStoreDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.storeService.create(dto, toOperator(user), ip);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateStoreDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.storeService.update(id, dto, toOperator(user), ip);
  }
}
