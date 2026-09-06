/**
 * /api/residents/[id]/move - transfer a resident to another building.
 *
 * The transfer and the history row are written in one transaction, so the
 * resident's current building and the trail that explains it can never diverge.
 */
import { moveResidentSchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseBody, parseIdParam } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { moveResident } from '@/lib/services/resident.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const POST = defineRoute<{ id: string }>(
  { role: 'ADMIN' },
  async ({ request, params, auth, origin }) => {
    const id = parseIdParam(params);
    const input = await parseBody(request, moveResidentSchema);
    // { resident, move }: the updated resident for the header, and the new
    // history entry for the transfers list on the same card.
    const result = await moveResident(id, input, auth);
    return ok(result, { origin });
  },
);
