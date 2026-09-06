/**
 * The wrapper every route handler is defined with.
 *
 * It owns the cross-cutting concerns so no individual route repeats them:
 * authentication, role authorization, rate limiting, request-size limits,
 * structured logging, CORS, and turning any thrown error into the standard
 * failure envelope with a correct status code.
 *
 *   Route Handler -> validation -> auth/authz -> service -> repository -> Prisma
 *
 * Business logic lives in `lib/services`. Routes stay thin.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z, type ZodTypeAny } from 'zod';
import type { UserRole } from '@hostel/shared';
import { Prisma } from '@prisma/client';
import { requireAuth, requireRole, type AuthContext } from '../auth/context';
import { AppError, InternalError, ValidationError, isAppError } from '../errors/app-error';
import { failure } from './response';
import { preflightResponse } from './headers';
import { logger, requestId } from './logger';
import { clientKey, enforceRateLimit } from './rate-limit';

/** Next.js 15 hands route params in asynchronously. */
type SegmentData<TParams> = { params: Promise<TParams> } | { params: TParams } | undefined;

export interface RouteContext<TParams = Record<string, string>> {
  request: NextRequest;
  params: TParams;
  auth: AuthContext;
  origin: string | null;
  requestId: string;
}

export interface RouteConfig {
  /** Minimum role required. Defaults to VIEWER (any signed-in user). */
  role?: UserRole;
  /** Set true only for genuinely public endpoints such as /api/health. */
  allowAnonymous?: boolean;
  /** Cost against the rate-limit budget; heavier reports can charge more. */
  rateLimitWeight?: number;
  /** Reject bodies larger than this. Uploads go straight to S3, so this is small. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MB

async function resolveParams<TParams>(segment: SegmentData<TParams>): Promise<TParams> {
  if (!segment) return {} as TParams;
  const value = segment.params as TParams | Promise<TParams>;
  return (value && typeof (value as Promise<TParams>).then === 'function'
    ? await value
    : value) as TParams;
}

function errorToResponse(error: unknown, origin: string | null, id: string): NextResponse {
  if (isAppError(error)) {
    if (error.status >= 500) {
      logger.error('Request failed', { requestId: id, code: error.code, error, ...error.logContext });
    } else {
      logger.info('Request rejected', {
        requestId: id,
        code: error.code,
        status: error.status,
        message: error.message,
      });
    }
    const headers =
      error.status === 429 && typeof error.logContext?.retryAfterSeconds === 'number'
        ? { 'Retry-After': String(error.logContext.retryAfterSeconds) }
        : undefined;
    return failure(
      error.status,
      { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      { origin, headers },
    );
  }

  // Translate the Prisma failures that map to a meaningful HTTP status.
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    logger.error('Database error', { requestId: id, prismaCode: error.code, meta: error.meta });
    if (error.code === 'P2002') {
      return failure(
        409,
        { code: 'DUPLICATE_RECORD', message: 'A record with those details already exists.' },
        { origin },
      );
    }
    if (error.code === 'P2003' || error.code === 'P2014') {
      return failure(
        409,
        {
          code: 'RECORD_IN_USE',
          message: 'That record is still referenced by other records and cannot be changed.',
        },
        { origin },
      );
    }
    if (error.code === 'P2025') {
      return failure(404, { code: 'NOT_FOUND', message: 'Record was not found' }, { origin });
    }
  }

  // Anything else is a bug. Log it in full; tell the client nothing.
  logger.error('Unhandled error', { requestId: id, error });
  const internal = new InternalError(error);
  return failure(internal.status, { code: internal.code, message: internal.message }, { origin });
}

/**
 * Define a route handler.
 *
 *   export const GET = defineRoute({ role: 'VIEWER' }, async ({ request, auth }) => { ... })
 */
export function defineRoute<TParams = Record<string, string>>(
  config: RouteConfig,
  handler: (context: RouteContext<TParams>) => Promise<NextResponse> | NextResponse,
): (request: NextRequest, segment?: SegmentData<TParams>) => Promise<NextResponse> {
  return async (request: NextRequest, segment?: SegmentData<TParams>) => {
    const id = requestId();
    const origin = request.headers.get('origin');
    const startedAt = Date.now();

    try {
      const contentLength = Number(request.headers.get('content-length') ?? '0');
      const maxBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'That request was too large.');
      }

      let auth: AuthContext;
      if (config.allowAnonymous) {
        enforceRateLimit(clientKey(request.headers), config.rateLimitWeight ?? 1);
        auth = {
          userId: '',
          name: 'anonymous',
          email: '',
          role: 'VIEWER',
          active: true,
          mustChangePassword: false,
        };
      } else {
        // Rate-limit anonymous callers by IP first so an unauthenticated flood
        // cannot force a JWKS fetch per request.
        enforceRateLimit(clientKey(request.headers), config.rateLimitWeight ?? 1);
        auth = await requireAuth(request);
        requireRole(auth, config.role ?? 'VIEWER');
        enforceRateLimit(`user:${auth.userId}`, config.rateLimitWeight ?? 1);
      }

      const params = await resolveParams<TParams>(segment);
      const response = await handler({ request, params, auth, origin, requestId: id });

      logger.info('Request completed', {
        requestId: id,
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
        durationMs: Date.now() - startedAt,
        userId: auth.userId || undefined,
      });

      return response;
    } catch (error) {
      return errorToResponse(error, origin, id);
    }
  };
}

/** CORS preflight, exported by every route module that needs it. */
export function optionsHandler(request: NextRequest): Response {
  return preflightResponse(request.headers.get('origin'));
}

/* ------------------------------------------------------------------ *
 * Input parsing
 * ------------------------------------------------------------------ */

function zodToDetails(error: z.ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_';
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

/** Parse and validate a JSON body. */
export async function parseBody<TSchema extends ZodTypeAny>(
  request: NextRequest,
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('The request body was not valid JSON');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError('Some of the details need fixing', zodToDetails(result.error));
  }
  return result.data;
}

/** Parse and validate the query string. */
export function parseQuery<TSchema extends ZodTypeAny>(
  request: NextRequest,
  schema: TSchema,
): z.infer<TSchema> {
  const raw: Record<string, string> = {};
  new URL(request.url).searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError('Some of the filters are not valid', zodToDetails(result.error));
  }
  return result.data;
}

/** Validate a path parameter that must be a database id (a MongoDB ObjectId). */
export function parseIdParam(params: Record<string, unknown>, key = 'id'): string {
  const value = params?.[key];
  const result = z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .safeParse(value);
  if (!result.success) {
    throw new ValidationError('That identifier is not valid', { [key]: ['Must be a valid id'] });
  }
  return result.data;
}
