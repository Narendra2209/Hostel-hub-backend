/**
 * POST /api/auth/bootstrap
 *
 * Creates the first OWNER on a fresh deployment and signs them straight in.
 *
 * Anonymous, because there is nobody to authenticate as yet - which makes "the
 * users collection is empty" the only thing protecting it. The service re-checks
 * that inside the transaction and refuses with 409 once any account exists, so
 * this endpoint stops working for good the moment it has been used once.
 *
 * Weighted heavily against the rate limit: it hashes a password, and it is the
 * one unauthenticated endpoint that writes.
 */
import { defineRoute, optionsHandler, parseBody } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { bootstrapSchema } from '@hostel/shared';
import { sessionCookie } from '@/lib/auth/jwt';
import { bootstrap } from '@/lib/services/auth.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const POST = defineRoute(
  { allowAnonymous: true, rateLimitWeight: 5 },
  async ({ request, origin }) => {
    const input = await parseBody(request, bootstrapSchema);
    const session = await bootstrap(input);

    return ok(session, {
      origin,
      status: 201,
      // The SPA keeps the token in memory for its Authorization header; the
      // cookie is what survives a page reload on a same-site deployment.
      headers: { 'Set-Cookie': sessionCookie(session.token, new Date(session.expiresAt)) },
    });
  },
);
