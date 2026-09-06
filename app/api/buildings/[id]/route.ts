/**
 * GET    /api/buildings/[id] - one building with its dependent-record counts.
 * PATCH  /api/buildings/[id] - rename / recode / reorder (the Settings screen
 *         saves names one building at a time).
 * DELETE /api/buildings/[id] - owner-only, and refused while any resident,
 *         staff member, bill or move-history entry still points at it.
 */
import { defineRoute, optionsHandler, parseBody, parseIdParam } from '@/lib/http/handler';
import { noContent, ok } from '@/lib/http/response';
import { updateBuildingSchema } from '@hostel/shared';
import { deleteBuilding, getBuilding, updateBuilding } from '@/lib/services/building.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute<{ id: string }>({ role: 'VIEWER' }, async ({ params, origin }) => {
  const id = parseIdParam(params);
  return ok(await getBuilding(id), { origin });
});

export const PATCH = defineRoute<{ id: string }>(
  { role: 'ADMIN' },
  async ({ request, params, auth, origin }) => {
    const id = parseIdParam(params);
    const input = await parseBody(request, updateBuildingSchema);
    return ok(await updateBuilding(id, input, auth), { origin });
  },
);

export const DELETE = defineRoute<{ id: string }>(
  { role: 'OWNER' },
  async ({ params, auth, origin }) => {
    const id = parseIdParam(params);
    await deleteBuilding(id, auth);
    return noContent({ origin });
  },
);
