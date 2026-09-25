/**
 * 业务错误码
 *
 * 统一响应：{ code, message, data }
 * code = 0 表示成功，其余为业务错误。
 */
export const BizCode = {
  OK: 0,
  /** 未登录 / token 失效 */
  UNAUTHORIZED: 1001,
  /** 无权限 / 跨租户越权 */
  FORBIDDEN: 1002,
  /** 参数校验失败 */
  BAD_REQUEST: 1003,
  /** 资源不存在 */
  NOT_FOUND: 1004,
  /** 账号或密码错误 */
  LOGIN_FAILED: 1005,
  /** 登录状态已失效（token_version 不匹配） */
  SESSION_REVOKED: 1006,
  /** 自锁保护：不能停用/删除自己或最后一个超管 */
  SELF_LOCK: 1007,
  /** 请求过于频繁（限流） */
  TOO_MANY_REQUESTS: 1008,

  /** 二维码无效 / 过期 / 已使用 */
  QR_INVALID: 2001,
  /** 次数不足 */
  QUOTA_EXHAUSTED: 2002,
  /** 重复核销 */
  DUPLICATE_VERIFY: 2003,
  /** 员工或公司已停用 */
  ACCOUNT_DISABLED: 2004,
  /** 不在可核销时段 / 时段内次数已用完 */
  OUT_OF_WINDOW: 2005,
  /** 设备密钥无效 */
  DEVICE_INVALID: 2006,
  /**
   * 员工个人核销次数已用完。
   *
   * 与 2002（公司总额度不足）分开，是因为处置动作完全不同：
   * 2002 要找平台充值，2006 要找公司管理员加次数。
   * 合并成一个码，小程序只能给一句含糊的"次数不足"。
   */
  EMPLOYEE_QUOTA_EXHAUSTED: 2007,
} as const;

export type BizCodeValue = (typeof BizCode)[keyof typeof BizCode];

/** 业务异常：由全局过滤器转成统一响应格式 */
export class BizException extends Error {
  constructor(
    public readonly code: BizCodeValue,
    message: string,
  ) {
    super(message);
    this.name = 'BizException';
  }

  static unauthorized(message = '未登录或登录已过期') {
    return new BizException(BizCode.UNAUTHORIZED, message);
  }

  static forbidden(message = '无权限访问') {
    return new BizException(BizCode.FORBIDDEN, message);
  }

  static badRequest(message = '参数错误') {
    return new BizException(BizCode.BAD_REQUEST, message);
  }

  static notFound(message = '资源不存在') {
    return new BizException(BizCode.NOT_FOUND, message);
  }

  static loginFailed(message = '账号或密码错误') {
    return new BizException(BizCode.LOGIN_FAILED, message);
  }

  static sessionRevoked(message = '登录状态已失效，请重新登录') {
    return new BizException(BizCode.SESSION_REVOKED, message);
  }

  static selfLock(message = '该操作会导致平台失去管理入口，已被拒绝') {
    return new BizException(BizCode.SELF_LOCK, message);
  }

  static tooManyRequests(message = '请求过于频繁，请稍后再试') {
    return new BizException(BizCode.TOO_MANY_REQUESTS, message);
  }

  static qrInvalid(message = '二维码无效或已过期') {
    return new BizException(BizCode.QR_INVALID, message);
  }

  static quotaExhausted(message = '剩余次数不足') {
    return new BizException(BizCode.QUOTA_EXHAUSTED, message);
  }

  static duplicateVerify(message = '该二维码已被使用，请刷新后重试') {
    return new BizException(BizCode.DUPLICATE_VERIFY, message);
  }

  static accountDisabled(message = '账号已停用') {
    return new BizException(BizCode.ACCOUNT_DISABLED, message);
  }

  static outOfWindow(message: string) {
    return new BizException(BizCode.OUT_OF_WINDOW, message);
  }

  static deviceInvalid(message = '设备密钥无效') {
    return new BizException(BizCode.DEVICE_INVALID, message);
  }

  static employeeQuotaExhausted(
    message = '您的核销次数已用完，请联系公司管理员',
  ) {
    return new BizException(BizCode.EMPLOYEE_QUOTA_EXHAUSTED, message);
  }
}
