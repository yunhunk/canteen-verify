import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { PlanService } from './plan.service';
import { Roles } from '../common/decorators/roles.decorator';
import { toOperator } from '../common/types/operator';
import { ClientIp, CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { ToInt } from '../common/dto/to-str.decorator';

class CreatePlanDto {
  @IsString() @IsNotEmpty({ message: '套餐名称不能为空' })
  name: string;

  @ToInt() @IsInt({ message: '包含次数必须是整数' }) @Min(0)
  quota: number;

  @IsOptional() @IsNumber() price?: number;
  @ToInt() @IsOptional() @Min(0) validDays?: number;
  @ToInt() @IsOptional() @Min(0) @Max(1) status?: number;
}

class UpdatePlanDto {
  @IsOptional() @IsString() name?: string;
  @ToInt() @IsOptional() @Min(0) quota?: number;
  @IsOptional() @IsNumber() price?: number;
  @ToInt() @IsOptional() @Min(0) validDays?: number;
  @ToInt() @IsOptional() @Min(0) @Max(1) status?: number;
}

@Controller('api/platform/plans')
@Roles('super')
export class PlanController {
  constructor(private readonly planService: PlanService) {}

  @Get()
  list() {
    return this.planService.listAll();
  }

  @Post()
  create(
    @Body() dto: CreatePlanDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.planService.create(dto, toOperator(user), ip);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePlanDto,
    @CurrentUser() user: JwtUser,
    @ClientIp() ip: string | null,
  ) {
    return this.planService.update(id, dto, toOperator(user), ip);
  }
}
