/**
 * POST /api/auth/logout
 *
 * Clears the session cookie.
 *
 * Anonymous on purpose: signing out must work even when the token has already
 * expired or been revoked, and a 401 here would leave the cookie sitting in the
 * browser. There is nothing to delete server-side - a session is a signed token,
 * not a row - so this only takes the cookie back.
 *
 * The token itself stays valid until it expires. An account that needs every
 * live session killed is deactivated or has its password reset, both of which
 * bump `tokenValidFrom`.
 */
import { defineRoute, optionsHandler } from '@/lib/http/handler';
import { noContent } from '@/lib/http/response';
import { clearSessionCookie } from '@/lib/auth/jwt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const POST = defineRoute({ allowAnonymous: true }, ({ origin }) => {
  const response = noContent({ origin });
  response.headers.set('Set-Cookie', clearSessionCookie());
  return response;
});
