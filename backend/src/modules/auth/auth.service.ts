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

const LOGIN_FAIL_WINDOW = 300; // 5 分钟
const LOGIN_FAIL_LIMIT = 10;   // 同账号 5 分钟内失败 10 次即锁定

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
   */
  async adminLogin(username: string, password: string, ip: string | null) {
    const failKey = `login:fail:${username}`;
    const fails = Number((await this.redis.get(failKey)) || 0);
    if (fails >= LOGIN_FAIL_LIMIT) {
      throw BizException.loginFailed('登录失败次数过多，请 5 分钟后再试');
    }

    const admin = await this.adminRepo.findOne({ where: { username } });
    const passOk = admin ? await bcrypt.compare(password, admin.password_hash) : false;

    if (!admin || !passOk) {
      await this.redis.incr(failKey, LOGIN_FAIL_WINDOW);
      await this.logs.record({
        companyId: admin?.company_id ?? null,
        module: 'auth',
        action: 'login_fail',
        description: `后台登录失败：账号 ${username}`,
        operatorName: username,
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
   */
  async employeeLogin(code: string, phone?: string, employeeNo?: string) {
    // 按 phone 维度限流（5 分钟 10 次），防暴力绑定
    if (phone) {
      const rlKey = `rl:emp_login:${phone}`;
      const cnt = await this.redis.incr(rlKey, LOGIN_FAIL_WINDOW);
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

      const where = phone ? { phone } : { employee_no: employeeNo };
      const candidate = await this.employeeRepo.findOne({ where });

      if (!candidate) {
        throw BizException.notFound('未找到对应员工，请联系公司管理员确认手机号/工号');
      }
      if (candidate.status !== 1) {
        throw BizException.accountDisabled('账号已停用，请联系公司管理员');
      }
      // 一人一号：openid 已被别人占用时不能顶掉
      if (candidate.openid && candidate.openid !== openid) {
        throw BizException.forbidden('该员工账号已绑定其他微信，请联系公司管理员');
      }

      const company = await this.companyRepo.findOne({ where: { id: candidate.company_id } });
      if (!company || company.status !== 1) {
        throw BizException.accountDisabled('所属公司已停用，请联系公司管理员');
      }

      candidate.openid = openid;
      employee = await this.employeeRepo.save(candidate);

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
}
