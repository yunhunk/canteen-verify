import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { AdminService } from './admin.service';
import { Roles } from '../common/decorators/roles.decorator';
import { toOperator } from '../common/types/operator';
import { ClientIp, CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { ToInt, ToStrOptional } from '../common/dto/to-str.decorator';

class CreateAdminDto {
  @IsString() @IsNotEmpty({ message: '账号不能为空' })
  username: string;

  @IsString() @MinLength(6, { message: '密码至少 6 位' })
  password: string;

  @IsOptional() @IsString() role?: string;
  @ToStrOptional() @IsOptional() companyId?: string;
}

class ChangePasswordDto {
  @IsString() @MinLength(6, { message: '新密码至少 6 位' })
  newPassword: string;

  /** 改自己时必须提供 */
  @IsOptional() @IsString() oldPassword?: string;
}

class SetAdminStatusDto {
  @ToInt() @IsInt() @Min(0) @Max(1) status: number;
}

/**
 * 管理账号管理：仅平台超管可访问
 *
 * 自锁保护在后端硬拦，同时列表返回 isSelf 供前端置灰按钮 ——
 * 前端只是体验层，判断依据仍以后端为准。
 */
@Controller('api/platform/admins')
@Roles('super')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.adminService.listAll(user.uid);
  }

  @Post()
  create(
    @Body() dto: CreateAdminDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.adminService.create(dto, toOperator(user), ip);
  }

  @Put(':id/password')
  changePassword(
    @Param('id') id: string,
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.adminService.changePassword(id, dto, toOperator(user), ip);
  }

  @Put(':id/status')
  setStatus(
    @Param('id') id: string,
    @Body() dto: SetAdminStatusDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.adminService.setStatus(id, dto.status, toOperator(user), ip);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.adminService.remove(id, toOperator(user), ip);
  }
}
