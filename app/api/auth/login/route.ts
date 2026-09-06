/**
 * POST /api/auth/login
 *
 * Exchange an email and password for a session. Anonymous, and the most
 * attacked endpoint in the application, so it carries a rate-limit weight of 5
 * on top of the per-account lockout the service applies.
 *
 * The password is read straight out of the parsed body into the service and is
 * never logged, audited or echoed back.
 */
import { defineRoute, optionsHandler, parseBody } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { loginSchema } from '@hostel/shared';
import { sessionCookie } from '@/lib/auth/jwt';
import { login } from '@/lib/services/auth.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const POST = defineRoute(
  { allowAnonymous: true, rateLimitWeight: 5 },
  async ({ request, origin }) => {
    const input = await parseBody(request, loginSchema);
    const session = await login(input);

    return ok(session, {
      origin,
      headers: { 'Set-Cookie': sessionCookie(session.token, new Date(session.expiresAt)) },
    });
  },
);
