/**
 * GET /api/me
 *
 * The signed-in account plus the permission flags the UI uses to decide which
 * buttons to render, and the `mustChangePassword` flag that sends an invited
 * account to the change-password screen before anything else.
 *
 * Everything comes from the authenticated context `defineRoute` has already
 * resolved against the User document, so this costs no extra query.
 */
import { defineRoute, optionsHandler } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { toCurrentUserDto } from '@/lib/auth/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'VIEWER' }, ({ auth, origin }) =>
  ok(toCurrentUserDto(auth), { origin }),
);
