/**
 * /api/residents/[id]/profile - everything the profile page renders, in one call.
 *
 * The resident, their lifetime totals, this month's position, arrears, the
 * month-by-month history, the full payment list and every building transfer.
 */
import { monthBuildingQuerySchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseIdParam, parseQuery } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { getResidentProfile } from '@/lib/services/resident.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute<{ id: string }>(
  { role: 'VIEWER' },
  async ({ request, params, origin }) => {
    const id = parseIdParam(params);
    const query = parseQuery(request, monthBuildingQuerySchema);
    const profile = await getResidentProfile(id, query);
    return ok(profile, { origin });
  },
);
