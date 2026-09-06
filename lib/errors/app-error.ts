/**
 * Structured application errors.
 *
 * Every error that reaches a client is one of these. The `message` is written
 * to be shown to a hostel manager; internal detail (stack traces, SQL, database
 * hostnames) stays in CloudWatch and is never serialised into the response.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR'
  | (string & {});

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, string[]>;
  /** Extra context for the server log only - never serialised to the client. */
  readonly logContext?: Record<string, unknown>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, string[]>; logContext?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.logContext = options.logContext;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Some of the details need fixing', details?: Record<string, string[]>) {
    super(400, 'VALIDATION_ERROR', message, { details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Please sign in to continue', logContext?: Record<string, unknown>) {
    super(401, 'UNAUTHORIZED', message, { logContext });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Your account does not have permission to do that') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(entity = 'Record', code: ErrorCode = 'NOT_FOUND') {
    super(404, code, `${entity} was not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: ErrorCode = 'CONFLICT') {
    super(409, code, message);
  }
}

export class UnprocessableError extends AppError {
  constructor(message: string, code: ErrorCode = 'UNPROCESSABLE') {
    super(422, code, message);
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(429, 'RATE_LIMITED', 'Too many requests. Please slow down and try again shortly.', {
      logContext: { retryAfterSeconds },
    });
  }
}

export class InternalError extends AppError {
  constructor(cause?: unknown) {
    super(500, 'INTERNAL_ERROR', 'Something went wrong on our side. Please try again.', { cause });
  }
}

/* ------------------------------------------------------------------ *
 * Domain-specific errors, so the client can react to a code rather than
 * pattern-matching on a message.
 * ------------------------------------------------------------------ */

export const residentNotFound = () => new NotFoundError('Resident', 'RESIDENT_NOT_FOUND');
export const buildingNotFound = () => new NotFoundError('Building', 'BUILDING_NOT_FOUND');
export const paymentNotFound = () => new NotFoundError('Payment', 'PAYMENT_NOT_FOUND');
export const staffNotFound = () => new NotFoundError('Staff member', 'STAFF_NOT_FOUND');
export const salaryPaymentNotFound = () =>
  new NotFoundError('Salary payment', 'SALARY_PAYMENT_NOT_FOUND');
export const expenseNotFound = () => new NotFoundError('Expense', 'EXPENSE_NOT_FOUND');
export const categoryNotFound = () => new NotFoundError('Expense category', 'CATEGORY_NOT_FOUND');

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
