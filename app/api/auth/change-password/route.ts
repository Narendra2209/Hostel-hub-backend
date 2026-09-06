/**
 * POST /api/auth/change-password
 *
 * Any signed-in account changes its own password. VIEWER is enough - this is
 * the one action every role must be able to perform, including an invited
 * account that is still carrying `mustChangePassword` and cannot use anything
 * else yet.
 *
 * The change signs out every other session, so the response carries a fresh
 * token (and cookie) to keep the caller where they are.
 */
import { defineRoute, optionsHandler, parseBody } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { changePasswordSchema } from '@hostel/shared';
import { sessionCookie } from '@/lib/auth/jwt';
import { changePassword } from '@/lib/services/auth.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const POST = defineRoute(
  // Weighted: it verifies one hash and computes another, and a wrong current
  // password should not be cheap to retry in bulk.
  { role: 'VIEWER', rateLimitWeight: 5 },
  async ({ request, auth, origin }) => {
    const input = await parseBody(request, changePasswordSchema);
    const session = await changePassword(auth, input);

    return ok(session, {
      origin,
      headers: { 'Set-Cookie': sessionCookie(session.token, new Date(session.expiresAt)) },
    });
  },
);
