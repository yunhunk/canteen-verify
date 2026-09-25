import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { BizCode, BizException } from '../biz-code';

/**
 * 全局异常过滤：把业务异常、参数校验失败、未捕获异常
 * 统一收敛成 { code, message, data: null }。
 *
 * 关键：HTTP 状态码用 4xx/5xx（便于网关、限流、监控识别），
 * body 里再给业务码 —— 两者不混用。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest();

    let httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: number = BizCode.BAD_REQUEST;
    let message = '服务器内部错误';

    if (exception instanceof BizException) {
      code = exception.code;
      message = exception.message;
      httpStatus = this.httpStatusOfBizCode(exception.code);
      this.logger.warn(`${req?.method} ${req?.url} → biz ${code} ${message}`);
    } else if (exception instanceof HttpException) {
      httpStatus = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const b = body as any;
        // class-validator 的 message 是数组，取首条给人读
        message = Array.isArray(b.message) ? b.message[0] : b.message || exception.message;
      }
      code = httpStatus === 401 ? BizCode.UNAUTHORIZED
        : httpStatus === 403 ? BizCode.FORBIDDEN
        : httpStatus === 404 ? BizCode.NOT_FOUND
        : BizCode.BAD_REQUEST;
    } else {
      // 未预期异常：记日志，但不把堆栈吐给客户端
      const err = exception as Error;
      this.logger.error(`${req?.method} ${req?.url} → ${err?.message}`, err?.stack);
      message = '服务器内部错误';
    }

    if (res.headersSent) {
      this.logger.error(`${req?.method} ${req?.url} → 响应头已发送，无法写入异常响应`);
      return;
    }
    res.status(httpStatus).json({ code, message, data: null });
  }

  /** 业务码 → HTTP 状态码。核销时段不满足等业务拒绝用 400，未登录 401，越权 403 */
  private httpStatusOfBizCode(bizCode: number): number {
    switch (bizCode) {
      case BizCode.UNAUTHORIZED:
      case BizCode.SESSION_REVOKED:
        return HttpStatus.UNAUTHORIZED;
      case BizCode.FORBIDDEN:
        return HttpStatus.FORBIDDEN;
      case BizCode.NOT_FOUND:
        return HttpStatus.NOT_FOUND;
      case BizCode.TOO_MANY_REQUESTS:
        return HttpStatus.TOO_MANY_REQUESTS;
      case BizCode.LOGIN_FAILED:
      case BizCode.SELF_LOCK:
        return HttpStatus.BAD_REQUEST;
      default:
        // 二维码无效 / 次数不足 / 重复核销 / 时段不满足 / 设备无效
        return HttpStatus.BAD_REQUEST;
    }
  }
}
