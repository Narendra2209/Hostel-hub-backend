/**
 * /api/reports/pnl - the Profit & loss statement.
 *
 * Cash basis: the statement reports money that actually moved. See
 * lib/services/pnl.service.ts for the full definition of every line.
 *
 * The report is heavier than a list endpoint (a roster, a year of bills, a year
 * of salaries and a grouped scan of the ledger), so it charges more against the
 * rate-limit budget - it is still a fixed handful of queries, never one per
 * building or per month.
 */
import { pnlQuerySchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseQuery } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { buildPnl } from '@/lib/services/pnl.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'VIEWER', rateLimitWeight: 3 }, async ({ request, origin }) => {
  const query = parseQuery(request, pnlQuerySchema);
  const report = await buildPnl(query);
  return ok(report, { origin });
});
