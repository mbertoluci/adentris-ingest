import { ArgumentsHost, HttpException } from '@nestjs/common';
import { InvalidInputError } from '../../domain/errors';
import { AppExceptionFilter } from './app-exception.filter';

interface CapturedResponse {
  statusCode: number;
  body: unknown;
}

function captureResponse(): { res: unknown; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, body: null };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  return { res, captured };
}

function hostFor(res: unknown): ArgumentsHost {
  return { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
}

describe('AppExceptionFilter', () => {
  const filter = new AppExceptionFilter();

  const classify = (exception: unknown): CapturedResponse => {
    const { res, captured } = captureResponse();
    filter.catch(exception, hostFor(res));
    return captured;
  };

  it('maps a null or primitive throw to 500 internal instead of crashing the filter', () => {
    // a non-object throw once turned the filter itself into a TypeError (candidate.status on null),
    // masking the real error. It must now degrade to a clean 500.
    for (const hostile of [null, undefined, 'boom', 42]) {
      expect(() => classify(hostile)).not.toThrow();
      expect(classify(hostile)).toEqual({ statusCode: 500, body: { error: { code: 'internal' } } });
    }
  });

  it('maps an InvalidInputError to 400 validation_failed', () => {
    expect(classify(new InvalidInputError('bad'))).toEqual({
      statusCode: 400,
      body: { error: { code: 'validation_failed' } },
    });
  });

  it('maps a body-parser-style error carrying a numeric status (413) without masking it as 500', () => {
    expect(classify({ status: 413, message: 'too large' })).toEqual({
      statusCode: 413,
      body: { error: { code: 'payload_too_large' } },
    });
  });

  it('never leaks a message or stack, only a fixed code', () => {
    const { body } = classify(new HttpException('leaky detail', 400));
    expect(body).toEqual({ error: { code: 'validation_failed' } });
  });
});
