/**
 * /api/residents/[id] - read, edit and remove one resident.
 */
import { updateResidentSchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseBody, parseIdParam } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { deleteResident, getResident, updateResident } from '@/lib/services/resident.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute<{ id: string }>({ role: 'VIEWER' }, async ({ params, origin }) => {
  const id = parseIdParam(params);
  const resident = await getResident(id);
  return ok(resident, { origin });
});

export const PATCH = defineRoute<{ id: string }>(
  { role: 'ADMIN' },
  async ({ request, params, auth, origin }) => {
    const id = parseIdParam(params);
    const input = await parseBody(request, updateResidentSchema);
    const resident = await updateResident(id, input, auth);
    return ok(resident, { origin });
  },
);

/**
 * Removing a resident.
 *
 * A resident with any fee payment on record is archived rather than deleted -
 * the response says so with `archived: true` - because deleting them would tear
 * a hole in the hostel's books. Only someone who never transacted is genuinely
 * removed. Either way the payments themselves are never touched.
 */
export const DELETE = defineRoute<{ id: string }>(
  { role: 'OWNER' },
  async ({ params, auth, origin }) => {
    const id = parseIdParam(params);
    const result = await deleteResident(id, auth);
    return ok(result, { origin });
  },
);
