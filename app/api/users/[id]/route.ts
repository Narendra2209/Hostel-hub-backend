/**
 * PATCH /api/users/[id]
 *
 * Rename an account, change its role, or (de)activate it. Owner-only, and
 * refused when it would leave the hostel without a single active owner - a
 * guard that now lives entirely in the service layer, since MongoDB has no
 * constraint that could express it.
 *
 * Deactivating also ends the account's live session; see `updateUser`.
 */
import { defineRoute, optionsHandler, parseBody, parseIdParam } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { updateUserSchema } from '@hostel/shared';
import { updateUser } from '@/lib/services/user.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const PATCH = defineRoute<{ id: string }>(
  { role: 'OWNER' },
  async ({ request, params, auth, origin }) => {
    const id = parseIdParam(params);
    const input = await parseBody(request, updateUserSchema);
    return ok(await updateUser(id, input, auth), { origin });
  },
);
