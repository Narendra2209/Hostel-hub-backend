/**
 * /api/residents/[id]/fee-status?year=2026 - one resident's Jan-Dec strip.
 *
 * Statuses come from the fee engine's `yearStrip`, so a cell on the profile page
 * and the same cell on the dashboard can never disagree.
 */
import { feeStatusQuerySchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseIdParam, parseQuery } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { getResidentFeeStatus } from '@/lib/services/resident.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute<{ id: string }>(
  { role: 'VIEWER' },
  async ({ request, params, origin }) => {
    const id = parseIdParam(params);
    const query = parseQuery(request, feeStatusQuerySchema);
    const strip = await getResidentFeeStatus(id, query);
    return ok(strip, { origin });
  },
);
