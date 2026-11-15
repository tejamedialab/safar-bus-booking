import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError, pgCode, pgConstraint, PG } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.originalUrl.split("?")[0]}`));
}

/**
 * Single place that shapes every error response:
 *   { "error": { "code": "SEAT_UNAVAILABLE", "message": "...", "details": ..., "requestId": "..." } }
 * Database constraint violations that slip past service checks are mapped to safe 409/400s
 * instead of leaking SQL details.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  let appErr: AppError;
  if (err instanceof AppError) {
    appErr = err;
  } else if (isBodyParserError(err)) {
    appErr = new AppError(400, 'MALFORMED_JSON', 'Request body is not valid JSON');
  } else {
    const code = pgCode(err);
    if (code === PG.EXCLUSION_VIOLATION) {
      appErr = new AppError(409, 'SEAT_UNAVAILABLE', 'One or more selected seats were just taken. Please pick again.', {
        constraint: pgConstraint(err),
      });
    } else if (code === PG.UNIQUE_VIOLATION) {
      appErr = new AppError(409, 'DUPLICATE', 'A record with these details already exists', {
        constraint: pgConstraint(err),
      });
    } else if (code === PG.FOREIGN_KEY_VIOLATION) {
      appErr = new AppError(400, 'INVALID_REFERENCE', 'A referenced record does not exist', {
        constraint: pgConstraint(err),
      });
    } else if (code === PG.CHECK_VIOLATION) {
      appErr = new AppError(400, 'CONSTRAINT_VIOLATION', 'A value failed a data rule', {
        constraint: pgConstraint(err),
      });
    } else {
      logger.error({ err, requestId: req.requestId }, 'Unhandled error');
      appErr = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
    }
  }
  res.status(appErr.status).json({
    error: {
      code: appErr.code,
      message: appErr.message,
      ...(appErr.details !== undefined ? { details: appErr.details } : {}),
      requestId: req.requestId,
    },
  });
}

function isBodyParserError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed';
}
