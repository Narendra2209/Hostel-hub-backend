/**
 * /api/residents/fee-status - Jan-Dec strips for many residents at once.
 *
 * This is the endpoint that keeps the dashboard's fee-card table to a single
 * request instead of one per resident. However many residents come back, the
 * service issues exactly two queries: the roster page, and that page's payments
 * for the requested calendar year.
 *
 * Filters: ?year= (required) &buildingId= &residentIds=a,b,c &limit=
 */
import { feeStatusBatchQuerySchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseQuery } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { getFeeStatusBatch } from '@/lib/services/resident.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'VIEWER' }, async ({ request, origin }) => {
  const query = parseQuery(request, feeStatusBatchQuerySchema);
  const strips = await getFeeStatusBatch(query);
  return ok(strips, { origin });
});
