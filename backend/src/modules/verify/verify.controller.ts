import { Body, Controller, Post } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, Length, Matches } from 'class-validator';
import { VerifyService } from './verify.service';
import { Public, Roles } from '../common/decorators/roles.decorator';
import { toOperator } from '../common/types/operator';
import { ClientIp, CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { ToStrOptional } from '../common/dto/to-str.decorator';
import { RedisService } from '../common/redis.service';
import { BizException } from '../common/biz-code';

class ScanVerifyDto {
  @IsString()
  @IsNotEmpty({ message: '缺少二维码凭证' })
  @Length(1, 200, { message: '二维码凭证长度不合法' })
  qrToken: string;

  @ToStrOptional() @IsOptional() storeId?: string;
}

class DeviceVerifyDto {
  /**
   * 一机一密钥（推荐）
   *
   * 长度与字符集在此处就校验掉，避免畸形输入被送进 scrypt KDF。
   * scryptSync 是内存硬（每次约 16MiB）的同步计算，若不先挡掉垃圾输入，
   * 未认证的攻击者可以用超长/畸形 deviceKey 放大 CPU 与内存消耗（CWE-770）。
   * 设备密钥由 generateDeviceKey() 产出：48 位十六进制字符。
   */
  @IsOptional()
  @IsString()
  @Length(1, 64, { message: '设备密钥长度不合法' })
  @Matches(/^[A-Za-z0-9_-]+$/, { message: '设备密钥包含非法字符' })
  deviceKey?: string;

  /** 旧的全局密钥，仅用于平滑过渡 */
  @IsOptional()
  @IsString()
  @Length(1, 128, { message: '设备令牌长度不合法' })
  deviceToken?: string;

  @IsString()
  @IsNotEmpty({ message: '缺少二维码凭证' })
  @Length(1, 200, { message: '二维码凭证长度不合法' })
  qrToken: string;

  @ToStrOptional() @IsOptional() storeId?: string;
}

@Controller('api')
export class VerifyController {
  constructor(
    private readonly verify: VerifyService,
    private readonly redis: RedisService,
  ) {}

  /**
   * 门店核销员扫码核销（员工端 JWT 鉴权）
   *
   * 与设备通道共用同一条核销链路 —— 业务规则（时段、扣减）只实现一次，
   * 避免两条通道行为不一致。
   *
   * ## 为什么限定 @Roles('employee')
   *
   * 该接口此前未声明任何角色，而旧 RolesGuard 是 fail-open 的，
   * 于是任何已登录主体（含其他租户的公司管理员）都能调用。
   * 配合下游「按二维码所属公司扣减」的逻辑，就形成了跨租户越权：
   * A 公司的人可以消耗 B 公司的配额。
   *
   * 核销是门店核销员的动作，因此只允许 employee 角色进入；
   * 租户归属的比对在 service 层做（见 verify.service.ts）。
   */
  @Post('verify/scan')
  @Roles('employee')
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
      // 传入调用者租户，service 层会与二维码所属公司比对
      verifierCompanyId: user.companyId,
      verifierRole: user.role,
      operator: toOperator(user),
      ip,
    });
  }

  /**
   * 扫码机器（扫码枪 / 闸机）专用
   *
   * 与用户 JWT 完全解耦：设备没有也不需要账号体系。
   * 用 @Public 跳过 JWT 守卫，鉴权完全由设备密钥承担。
   *
   * ## 限流为什么是三层
   *
   * 原来只有「按客户端 IP」一层，而 IP 取自可伪造的 X-Forwarded-For，
   * 轮换请求头即可每次获得全新配额 —— 等于没有限流，还能顺带
   * 用同步 scrypt 把事件循环打满。
   *
   * 现在叠加攻击者无法零成本伪造的维度：
   *   1. 按设备密钥（每把钥匙自己的预算，轮换 IP 无效）
   *   2. 按二维码令牌（防单码被反复探测）
   *   3. 全局限流（防整体被打穿，轮换任何标识都无法突破）
   */
  @Public()
  @Post('device/verify')
  async deviceVerify(@Body() dto: DeviceVerifyDto, @ClientIp() ip: string | null) {
    // 1. 全局总预算：无论怎么轮换标识，整个端点每分钟最多 N 次
    const globalCnt = await this.redis.incr('rl:device_verify:__global__', 60);
    if (globalCnt > 600) throw BizException.tooManyRequests();

    // 2. 按设备密钥（用明文做键——同一把钥匙的请求才共享预算；
    //    仅取前缀避免把完整密钥写进 Redis 键空间）
    if (dto.deviceKey) {
      const keyCnt = await this.redis.incr(
        `rl:device_verify:key:${dto.deviceKey.slice(0, 12)}`,
        60,
      );
      if (keyCnt > 60) throw BizException.tooManyRequests();
    }

    // 3. 按二维码令牌（防单码被反复探测）
    const qrCnt = await this.redis.incr(
      `rl:device_verify:qr:${dto.qrToken.slice(0, 24)}`,
      60,
    );
    if (qrCnt > 30) throw BizException.tooManyRequests();

    // 4. 按来源 IP（兜底；IP 已改为可信来源，见 ClientIp 装饰器）
    const ipKey = `rl:device_verify:ip:${ip ?? 'unknown'}`;
    const cnt = await this.redis.incr(ipKey, 60);
    if (cnt > 30) throw BizException.tooManyRequests();

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
      verifierCompanyId: device?.company_id ? String(device.company_id) : null,
      verifierRole: 'device',
      operator: {
        uid: null,
        name: device ? `设备:${device.name}` : '设备:legacy',
        role: 'device',
      },
      ip,
    });
  }
}
