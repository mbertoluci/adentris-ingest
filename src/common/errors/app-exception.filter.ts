import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { InvalidInputError } from '../../domain/errors';
import { AppException, ErrorCode } from './app-exception';

const STATUS_CODE: Record<number, ErrorCode> = {
  400: 'validation_failed',
  413: 'payload_too_large',
  415: 'unsupported_media',
};

/**
 * The single HTTP-boundary filter. It never imports the driver: the repository already
 * translated Mongo into AppException. The body carries a fixed `code` the sender programs
 * against - never err.message, a stack, or any clinical field.
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, code } = this.classify(exception);
    if (status >= 500) {
      this.logger.error(`${code}: ${this.safeReason(exception)}`);
    }
    res.status(status).json({ error: { code } });
  }

  private classify(exception: unknown): { status: number; code: ErrorCode } {
    if (exception instanceof AppException) {
      return { status: exception.httpStatus, code: exception.code };
    }
    if (exception instanceof InvalidInputError) {
      return { status: 400, code: 'validation_failed' };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { status, code: STATUS_CODE[status] ?? 'internal' };
    }
    // body-parser errors (e.g. a body over the limit) are not HttpExceptions: they carry a
    // numeric status. Map the known client ones (413/415/400) instead of masking them as 500.
    const status = this.statusOf(exception);
    if (status !== undefined && STATUS_CODE[status]) {
      return { status, code: STATUS_CODE[status] };
    }
    return { status: 500, code: 'internal' };
  }

  private statusOf(exception: unknown): number | undefined {
    const candidate = exception as { status?: unknown; statusCode?: unknown };
    if (typeof candidate.status === 'number') {
      return candidate.status;
    }
    if (typeof candidate.statusCode === 'number') {
      return candidate.statusCode;
    }
    return undefined;
  }

  private safeReason(exception: unknown): string {
    return exception instanceof Error ? exception.name : 'unknown';
  }
}
