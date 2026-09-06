/**
 * Edge middleware: CORS preflight for /api/*.
 *
 * A browser sends OPTIONS before any cross-origin request that carries an
 * Authorization header. Answering it here means every API route gets a correct
 * preflight, and the preflight never pays for a cold start of the route module,
 * a Prisma connection or a Cognito JWKS fetch. Everything else is passed
 * straight through - real responses carry their own CORS and security headers
 * from lib/http/response.ts.
 *
 * Why the origin logic is duplicated here rather than imported
 * -----------------------------------------------------------
 * Middleware is compiled for the edge runtime, which does not apply the
 * `.js` -> `.ts` extension aliasing that the Node runtime uses, so importing
 * `lib/http/headers.ts` (and the `lib/env.ts` it pulls in) fails to resolve at
 * build time. Rather than change the import convention of 40 server files for
 * the sake of one edge file, the handful of lines needed for a preflight are
 * inlined. They must stay in step with `isOriginAllowed` in lib/http/headers.ts;
 * both read the same FRONTEND_URL allow-list, and neither ever echoes an origin
 * it has not vetted.
 */
import { NextResponse, type NextRequest } from 'next/server';

function allowedOrigins(): string[] {
  return (process.env.FRONTEND_URL ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  const normalised = origin.replace(/\/$/, '');
  if (allowedOrigins().includes(normalised)) return true;
  // Local development convenience only - any localhost port is acceptable.
  if (
    process.env.NODE_ENV !== 'production' &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalised)
  ) {
    return true;
  }
  return false;
}

export function middleware(request: NextRequest): Response {
  if (request.method !== 'OPTIONS') return NextResponse.next();

  const origin = request.headers.get('origin');
  if (!isOriginAllowed(origin)) {
    return new Response(null, { status: 403, headers: { Vary: 'Origin' } });
  }

  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin!.replace(/\/$/, ''),
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** Static matcher - Next requires this to be statically analysable. */
export const config = {
  matcher: '/api/:path*',
};
