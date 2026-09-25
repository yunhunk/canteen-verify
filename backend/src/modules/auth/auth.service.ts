import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { Inject } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../config/app.config';
import { Admin, Company, Employee } from '../../database/entities';
import { BizException } from '../common/biz-code';
import { RedisService } from '../common/redis.service';
import { OperationLogService } from '../operation-log/operation-log.service';
import { JwtUser } from '../common/decorators/current-user.decorator';

const LOGIN_FAIL_WINDOW = 300; // 5 分钟
const LOGIN_FAIL_LIMIT = 10;   // 同账号 5 分钟内失败 10 次即锁定
/**
 * 同一来源 IP 的失败上限。
 *
 * 比账号维度宽松（一个办公室/出口 NAT 下会有多个正常用户共用 IP），
 * 但足以卡死「不断换账号名」的密码喷洒 —— 单靠账号维度计数，
 * 攻击者每换一个拼写就获得一份新配额，等于没限流。
 */
const LOGIN_FAIL_IP_LIMIT = 50;

@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectRepository(Admin) private readonly adminRepo: Repository<Admin>,
    @InjectRepository(Employee) private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly logs: OperationLogService,
  ) {}

  // ---------------------------------------------------------------
  // 后台账号登录
  // ---------------------------------------------------------------

  /**
   * 后台登录（公司/平台共用入口，按 role 分流）。
   *
   * 三个必须做对的地方：
   * 1. 账号不存在与密码错误返回同一条文案 —— 否则等于给攻击者一个
   *    「账号存在性探测器」。
   * 2. 失败限流按账号计数，避免暴力破解。
   * 3. token 里带上 tv（token_version），改密/停用后可立即吊销。
   *
   * ## 关于用户名规范化（修复 CWE-307 绕过）
   *
   * 数据库里 username 列是 utf8mb4_unicode_ci —— **大小写不敏感且忽略尾随空格**，
   * 所以 'admin'、'Admin'、'ADMIN'、'admin  ' 命中的是同一行。
   * 但限流计数器的键此前直接用原始字符串拼，导致每种拼写各有一份配额，
   * 攻击者靠变换大小写就能无限次尝试。
   *
   * 现在统一规范化后再用于「限流键」和「数据库查询」，两者口径一致。
   */
  async adminLogin(username: string, password: string, ip: string | null) {
    // 规范化：Unicode NFKC → 去首尾空白 → 转小写
    // 与 MySQL utf8mb4_unicode_ci 的比较语义对齐
    const uname = String(username ?? '')
      .normalize('NFKC')
      .trim()
      .toLowerCase();

    if (!uname) throw BizException.loginFailed();

    // 限流键同时按账号与 IP，防止「只换账号名」的喷洒式攻击
    const failKey = `login:fail:${uname}`;
    const ipKey = `login:fail:ip:${ip ?? 'unknown'}`;
    const fails = Number((await this.redis.get(failKey)) || 0);
    const ipFails = Number((await this.redis.get(ipKey)) || 0);
    if (fails >= LOGIN_FAIL_LIMIT || ipFails >= LOGIN_FAIL_IP_LIMIT) {
      throw BizException.loginFailed('登录失败次数过多，请 5 分钟后再试');
    }

    const admin = await this.adminRepo.findOne({ where: { username: uname } });
    const passOk = admin ? await bcrypt.compare(password, admin.password_hash) : false;

    if (!admin || !passOk) {
      await this.redis.incr(failKey, LOGIN_FAIL_WINDOW);
      await this.redis.incr(ipKey, LOGIN_FAIL_WINDOW);
      await this.logs.record({
        companyId: admin?.company_id ?? null,
        module: 'auth',
        action: 'login_fail',
        description: `后台登录失败：账号 ${uname}`,
        operatorName: uname,
        operatorRole: admin?.role ?? null,
        targetType: 'admin',
        targetId: admin?.id ?? null,
        ip,
      });
      throw BizException.loginFailed();
    }

    if (admin.status !== 1) {
      throw BizException.accountDisabled('账号已停用，请联系平台管理员');
    }

    // 登录成功清空失败计数
    await this.redis.del(failKey);

    // 公司管理员必须绑定了公司，否则会越权看到跨租户数据
    if (admin.role === 'company') {
      if (!admin.company_id) {
        throw BizException.forbidden('账号未绑定公司，请联系平台管理员');
      }
      const company = await this.companyRepo.findOne({ where: { id: admin.company_id } });
      if (!company) {
        throw BizException.forbidden('所属公司不存在，请联系平台管理员');
      }
      if (company.status !== 1) {
        throw BizException.accountDisabled('所属公司已停用，请联系平台管理员');
      }
    }

    const token = await this.signAdminToken(admin);

    await this.logs.record({
      companyId: admin.company_id,
      module: 'auth',
      action: 'login',
      description: `${admin.username} 登录后台`,
      operatorId: admin.id,
      operatorName: admin.username,
      operatorRole: admin.role,
      targetType: 'admin',
      targetId: admin.id,
      ip,
    });

    return {
      token,
      user: {
        id: String(admin.id),
        username: admin.username,
        role: admin.role,
        companyId: admin.company_id ? String(admin.company_id) : null,
      },
    };
  }

  private async signAdminToken(admin: Admin) {
    return this.jwt.signAsync(
      {
        uid: String(admin.id),
        companyId: admin.company_id ? String(admin.company_id) : null,
        role: admin.role,
        tv: admin.token_version ?? 1,
      },
      { expiresIn: this.config.jwtExpiresIn },
    );
  }

  // ---------------------------------------------------------------
  // 登出（服务端会话终止）
  // ---------------------------------------------------------------

  /**
   * 登出：递增调用者的 token_version，使已签发的全部 JWT 立即失效。
   *
   * ## 原理
   *
   * JwtAuthGuard 在每个请求上都会加载对应用户记录，并把 payload.tv
   * 与库里的 token_version 比对；不一致就判定 sessionRevoked。
   * 因此这里只需把版本号 +1，所有旧令牌下一请求即被拒。
   *
   * 这对两类主体都生效：
   *   - 管理员（super / company）→ admins.token_version
   *   - 员工 → employees.token_version
   *
   * 设备通道没有 JWT，不涉及登出（换发密钥即等同于吊销）。
   *
   * ## 副作用说明
   *
   * 递增会让该主体的**所有**会话失效，而不只是当前这一个。
   * 当前设计没有「按设备/按会话」的令牌粒度（无 jti 体系），
   * 这是可接受的取舍：登出即「我怀疑凭据不安全，全部踢掉」。
   */
  async logout(user: JwtUser, ip: string | null) {
    if (!user?.uid) throw BizException.unauthorized();

    if (user.role === 'super' || user.role === 'company') {
      const admin = await this.adminRepo.findOne({ where: { id: user.uid } });
      if (admin) {
        await this.adminRepo.increment({ id: user.uid }, 'token_version', 1);
        await this.logs.record({
          companyId: admin.company_id,
          module: 'auth',
          action: 'logout',
          description: `${admin.username} 退出登录（会话已服务端终止）`,
          operatorId: admin.id,
          operatorName: admin.username,
          operatorRole: admin.role,
          targetType: 'admin',
          targetId: admin.id,
          ip,
        });
      }
    } else if (user.role === 'employee') {
      const employee = await this.employeeRepo.findOne({ where: { id: user.uid } });
      if (employee) {
        await this.employeeRepo.increment({ id: user.uid }, 'token_version', 1);
        await this.logs.record({
          companyId: String(employee.company_id),
          module: 'auth',
          action: 'logout',
          description: `员工 ${employee.name} 退出登录（会话已服务端终止）`,
          operatorId: employee.id,
          operatorName: employee.name,
          operatorRole: 'employee',
          targetType: 'employee',
          targetId: employee.id,
          ip,
        });
      }
    }

    // 幂等：重复登出不报错，客户端只管清本地状态
    return { success: true };
  }

  // ---------------------------------------------------------------
  // 员工微信登录
  // ---------------------------------------------------------------

  /**
   * 用 code 换 openid（微信 code2session）。
   * 未配置 appId 时走本地 mock —— 便于零依赖联调，但生产必须配。
   */
  async code2session(code: string): Promise<string> {
    const { appId, appSecret } = this.config.wechat;
    if (!appId || !appSecret) {
      if (this.config.localMode) {
        this.logger.warn('未配置微信 appId/appSecret，使用本地 mock openid（仅限开发）');
        return `mock_openid_${code}`;
      }
      // P0-2 修复：生产模式拒绝 mock，统一报错（启动校验已拦截但仍保留运行时防御）
      throw BizException.unauthorized('微信登录未配置，请联系管理员');
    }
    const url =
      `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(appId)}` +
      `&secret=${encodeURIComponent(appSecret)}&js_code=${encodeURIComponent(code)}` +
      `&grant_type=authorization_code`;
    // P1-6 修复：fetch 加超时，防微信慢响应拖垮
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let data: any;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`wx http ${res.status}`);
      data = await res.json() as any;
    } catch (e) {
      throw BizException.unauthorized('微信登录失败，请重试');
    } finally {
      clearTimeout(timer);
    }
    // P1-3 修复：不把整段响应（含 session_key）写日志
    if ((data as any).errcode) {
      this.logger.error(`code2session 失败: errcode=${(data as any).errcode}`);
      throw BizException.unauthorized('微信登录失败，请重试');
    }
    if (!(data as any).openid) {
      throw BizException.unauthorized('微信登录失败，请重试');
    }
    return (data as any).openid as string;
  }

  /**
   * 员工登录 / 绑定
   *
   * - 已绑定 openid → 直接签发 JWT
   * - 未绑定 → 用手机号（或工号）匹配员工 → 绑定 openid → 签发 JWT
   *
   * ## 修复的四个安全问题
   *
   * 1. **限流绕过（CWE-307）**：原来限流放在 `if (phone)` 内部，
   *    只传 employeeNo 的请求完全不受限，可无限枚举工号并抢占绑定。
   *    现在无论用哪个标识符、以及来源 IP，都无条件计数。
   *
   * 2. **跨租户越权绑定（CWE-639）**：原来 `findOne({ where: { employee_no } })`
   *    不带租户条件，而 employee_no 跨公司并不唯一，任意微信用户都能绑到
   *    任意公司任意员工。现在工号路径必须同时提供 phone 做二次确认。
   *
   * 3. **TOCTOU 竞态（CWE-362）**：原来「读→内存判断 openid→save」非原子，
   *    两个并发请求都能通过检查。现在改用条件 UPDATE，由数据库保证
   *    「只有当 openid 为空或就是自己时才能写入」。
   *
   * 4. **存在性预言机**：原来「未找到员工」(404) 与「已绑其他微信」(403)
   *    错误可区分，可用于枚举。现在统一为同一条通用文案。
   */
  async employeeLogin(
    code: string,
    phone?: string,
    employeeNo?: string,
    ip?: string | null,
  ) {
    // ── 限流：无条件执行，覆盖 phone / employeeNo / IP 三个维度
    //    任一维度超限即拒绝，封死「换个标识符就有新配额」的绕过路径。
    const window = LOGIN_FAIL_WINDOW;
    const rlKeys: string[] = [`rl:emp_login:ip:${ip ?? 'unknown'}`];
    if (phone) rlKeys.push(`rl:emp_login:phone:${phone}`);
    if (employeeNo) rlKeys.push(`rl:emp_login:no:${employeeNo}`);
    for (const key of rlKeys) {
      const cnt = await this.redis.incr(key, window);
      if (cnt > LOGIN_FAIL_LIMIT) {
        throw BizException.tooManyRequests('尝试次数过多，请 5 分钟后再试');
      }
    }

    const openid = await this.code2session(code);

    // 已绑定的直接登录
    let employee = await this.employeeRepo.findOne({ where: { openid } });

    if (!employee) {
      if (!phone && !employeeNo) {
        // 告知前端需要补充手机号
        return { needBind: true as const };
      }

      const candidate = await this.resolveBindCandidate(phone, employeeNo);

      if (!candidate) {
        // 统一文案：不区分「员工不存在」与「已绑他人微信」，避免枚举
        await this.recordBindFail(phone, employeeNo, ip);
        throw BizException.forbidden('绑定失败，请核对信息或联系公司管理员');
      }
      if (candidate.status !== 1) {
        throw BizException.accountDisabled('账号已停用，请联系公司管理员');
      }

      const company = await this.companyRepo.findOne({ where: { id: candidate.company_id } });
      if (!company || company.status !== 1) {
        throw BizException.accountDisabled('所属公司已停用，请联系公司管理员');
      }

      // ── 原子绑定：条件 UPDATE 由数据库保证互斥
      //     WHERE 确保只有 (openid IS NULL) 或 (openid = 自己) 才能写入，
      //     并发下只有一个请求能 affected=1，其余自然失败。
      const result = await this.employeeRepo
        .createQueryBuilder()
        .update(Employee)
        .set({ openid })
        .where('id = :id', { id: candidate.id })
        .andWhere('(openid IS NULL OR openid = :openid)', { openid })
        .execute();

      // affected=0 说明并发下已被别人抢先绑定 —— 返回同样的通用错误
      if (!result.affected) {
        await this.recordBindFail(phone, employeeNo, ip);
        throw BizException.forbidden('绑定失败，请核对信息或联系公司管理员');
      }

      // 重新读回完整记录（条件 UPDATE 不回填实体）
      const bound = await this.employeeRepo.findOne({ where: { id: candidate.id } });
      if (!bound) throw BizException.notFound('员工不存在');
      employee = bound;

      await this.logs.record({
        companyId: String(employee.company_id),
        module: 'auth',
        action: 'bind',
        description: `员工 ${employee.name} 首次绑定微信`,
        operatorId: employee.id,
        operatorName: employee.name,
        operatorRole: 'employee',
        targetType: 'employee',
        targetId: employee.id,
        ip,
      });
    }

    if (employee.status !== 1) {
      throw BizException.accountDisabled('账号已停用，请联系公司管理员');
    }

    const company = await this.companyRepo.findOne({ where: { id: employee.company_id } });
    if (!company || company.status !== 1) {
      throw BizException.accountDisabled('所属公司已停用，请联系公司管理员');
    }

    // 签发前重新读一次库取 token_version。
    // 不能直接用上面的 employee：新绑定分支里它是 save() 的返回值，
    // 而 save() **不回填数据库默认值列**，token_version 会是 undefined。
    // 若此时兜底成 1、而库里其实已因解绑递增到 2，员工一登录就会被
    // 守卫判定「会话失效」，表现为"刚绑完就被踢出去"。
    const fresh = await this.employeeRepo.findOne({ where: { id: employee.id } });
    if (fresh) employee = fresh;

    const token = await this.jwt.signAsync(
      {
        uid: String(employee.id),
        companyId: String(employee.company_id),
        role: 'employee',
        name: employee.name,
        // 解绑微信时该值递增，守卫据此让旧 token 立即失效
        tv: employee.token_version ?? 1,
      },
      { expiresIn: this.config.jwtExpiresIn },
    );

    // 登录成功：清空本次涉及的限流计数
    await Promise.all(rlKeys.map((k) => this.redis.del(k)));

    return {
      needBind: false as const,
      token,
      user: {
        id: String(employee.id),
        name: employee.name,
        companyId: String(employee.company_id),
        companyName: company.name,
        employeeNo: employee.employee_no,
      },
    };
  }

  /**
   * 解析绑定目标员工。
   *
   * ## 为什么工号路径必须带手机号
   *
   * employee_no 在库中没有全局唯一约束 —— A 公司的 A0001 与 B 公司的
   * A0001 是两行不同记录。若仅凭工号匹配，任意微信用户就能把 openid
   * 绑到任意公司的任意员工上（CWE-639 越权绑定），并拿到携带该员工
   * companyId 的 JWT。
   *
   * 因此工号路径强制要求 phone 作为第二因素，且两者必须命中**同一行**。
   * 若业务上确需支持「只用工号登录」，应先为 employee_no 建全局唯一索引。
   */
  private async resolveBindCandidate(phone?: string, employeeNo?: string) {
    if (phone) {
      const byPhone = await this.employeeRepo.findOne({ where: { phone } });
      if (!byPhone) return null;
      // 同时给了工号 → 必须与手机号命中同一行，防止跨公司拼凑
      if (employeeNo && String(byPhone.employee_no) !== String(employeeNo)) {
        return null;
      }
      return byPhone;
    }

    // 只有工号、没有手机号：不可作为身份凭据（可枚举 + 跨租户不唯一）
    if (employeeNo) {
      this.logger.warn(
        `拒绝仅凭工号绑定：employeeNo=${employeeNo}（需手机号二次确认）`,
      );
    }
    return null;
  }

  /** 记录一次绑定失败（审计用），不向调用方暴露具体原因 */
  private async recordBindFail(phone: string | undefined, employeeNo: string | undefined, ip: string | null | undefined) {
    await this.logs.record({
      companyId: null,
      module: 'auth',
      action: 'bind_fail',
      description: '员工绑定失败（凭据不匹配或已被占用）',
      operatorName: phone ? `phone:${phone.slice(0, 3)}***` : `no:${employeeNo ?? '-'}`,
      operatorRole: 'employee',
      targetType: 'employee',
      targetId: null,
      ip,
    });
  }
}
