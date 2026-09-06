/**
 * GET /api/auth/status
 *
 * The one thing the login screen needs before anyone has signed in: whether
 * this deployment still has to create its first owner, and what to call the
 * hostel while it does. Anonymous by necessity - on a fresh database there is
 * nobody to authenticate as - and read-only, so it answers correctly against a
 * completely empty cluster without creating anything.
 */
import { defineRoute, optionsHandler } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { getAuthStatus } from '@/lib/services/auth.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ allowAnonymous: true }, async ({ origin }) =>
  ok(await getAuthStatus(), { origin }),
);
