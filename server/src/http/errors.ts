// 공통 오류 형식: {"error": {"code", "message", "details"}} (API 명세 · 오류 코드표)
import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', '요청한 주소를 찾을 수 없어요'));
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  // Express는 인자가 4개인 함수를 오류 처리기로 알아본다. next를 안 써도 지우면 안 된다.
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    if (err instanceof AppError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }

    // 깨진 JSON 본문: 본문에 환자 정보가 있을 수 있어 err.body는 로그에 남기지 않는다 (SER-012)
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({
        error: { code: 'VALIDATION_FAILED', message: '입력 형식이 맞지 않아요' },
      });
      return;
    }

    // 예상 못 한 오류는 내부 내용을 숨기고, 원인은 서버 로그에만 남긴다.
    // stack 첫 줄은 오류 메시지라 주소·SQL 값 같은 입력이 섞일 수 있어 빼고, 코드 위치만 남긴다 (SER-012)
    const where =
      typeof err?.stack === 'string' ? err.stack.split('\n').slice(1).join('\n') : undefined;
    logger.error(
      { name: err?.name, stack: where, method: req.method, path: req.path },
      '처리 못 한 오류',
    );
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: '서버에 문제가 생겼어요' },
    });
  };
}
