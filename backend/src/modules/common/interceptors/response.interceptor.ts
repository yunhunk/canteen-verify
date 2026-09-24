import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

/**
 * 统一响应包装：{ code: 0, message: 'success', data: ... }
 *
 * 已是该形状的返回值（如导出接口直接写的 StreamableFile）不再二次包装。
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T> | T> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResponse<T> | T> {
    const res = context.switchToHttp().getResponse();
    return next.handle().pipe(
      map((data) => {
        // CSV 导出等直接设置 Content-Type 的接口，跳过包装
        const ct = res.getHeader?.('Content-Type');
        if (typeof ct === 'string' && !ct.includes('application/json')) {
          return data;
        }
        if (data && typeof data === 'object' && 'code' in data && 'message' in data && 'data' in data) {
          return data;
        }
        return { code: 0, message: 'success', data: data === undefined ? null : data };
      }),
    );
  }
}
