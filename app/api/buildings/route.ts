/**
 * GET  /api/buildings - every building with its dependent-record counts.
 * POST /api/buildings - add one (Settings screen, "Add a building").
 *
 * The list is two queries whatever the number of buildings; see
 * `lib/repositories/building.repository.ts`.
 */
import { defineRoute, optionsHandler, parseBody } from '@/lib/http/handler';
import { created, ok } from '@/lib/http/response';
import { createBuildingSchema } from '@hostel/shared';
import { createBuilding, listBuildings } from '@/lib/services/building.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'VIEWER' }, async ({ origin }) =>
  ok(await listBuildings(), { origin }),
);

export const POST = defineRoute({ role: 'ADMIN' }, async ({ request, auth, origin }) => {
  const input = await parseBody(request, createBuildingSchema);
  return created(await createBuilding(input, auth), { origin });
});
