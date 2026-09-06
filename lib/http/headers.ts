/**
 * CORS and security headers.
 *
 * CORS is an allow-list built from FRONTEND_URL, never `*`, because the API
 * accepts credentials-bearing Authorization headers.
 */
import { allowedOrigins, isProduction } from '../env';

export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  const normalised = origin.replace(/\/$/, '');
  const list = allowedOrigins();
  if (list.includes(normalised)) return true;
  // Convenience for local development only: any localhost port is fine.
  if (!isProduction() && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalised)) {
    return true;
  }
  return false;
}

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!isOriginAllowed(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin!.replace(/\/$/, ''),
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export function securityHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-site',
    // This API returns JSON only; nothing should ever be rendered from it.
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    // Financial data must not be cached by intermediaries.
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  };
  if (isProduction()) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

/** Response to a CORS preflight. */
export function preflightResponse(origin: string | null): Response {
  return new Response(null, {
    status: isOriginAllowed(origin) ? 204 : 403,
    headers: { ...corsHeaders(origin), ...securityHeaders() },
  });
}
