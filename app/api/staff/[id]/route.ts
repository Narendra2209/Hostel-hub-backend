/**
 * /api/staff/[id] - edit a staff member, or remove them from the register.
 */
import { updateStaffSchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseBody, parseIdParam } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { removeStaff, updateStaff } from '@/lib/services/staff.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

/** `active: false` is how the UI marks somebody as having left. */
export const PATCH = defineRoute<{ id: string }>(
  { role: 'ADMIN' },
  async ({ request, params, auth, origin }) => {
    const id = parseIdParam(params);
    const input = await parseBody(request, updateStaffSchema);
    const staff = await updateStaff(id, input, auth);
    return ok(staff, { origin });
  },
);

/**
 * Removing somebody who has ever been paid would orphan salary history, so the
 * record is archived instead and the response says which happened.
 */
export const DELETE = defineRoute<{ id: string }>(
  { role: 'OWNER' },
  async ({ params, auth, origin }) => {
    const id = parseIdParam(params);
    const result = await removeStaff(id, auth);
    return ok(result, { origin });
  },
);
