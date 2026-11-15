/**
 * Every expected failure is an AppError with a stable machine-readable code.
 * The error middleware turns it into: { error: { code, message, details?, requestId } }
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (entity: string) => new AppError(404, 'NOT_FOUND', `${entity} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const gone = (code: string, message: string) => new AppError(410, code, message);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);

/** Postgres error codes we translate into business errors. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
  SERIALIZATION_FAILURE: '40001',
} as const;

export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'constraint' in err
    ? String((err as { constraint: unknown }).constraint)
    : undefined;
}
