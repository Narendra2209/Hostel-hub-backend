/**
 * GET /api/overdue
 *
 * Every unpaid billing month whose due date has passed, either one row per
 * month (`groupBy=month`, the reference table) or one row per person
 * (`groupBy=resident`). The three stat cards read from `meta.totals`.
 */
import { overdueQuerySchema, type OverdueResponseMeta } from '@hostel/shared';
import { defineRoute, optionsHandler, parseQuery } from '@/lib/http/handler';
import { buildPaginationMeta, paginated } from '@/lib/http/response';
import { getOverdue } from '@/lib/services/overdue.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'VIEWER' }, async ({ request, origin }) => {
  const query = parseQuery(request, overdueQuerySchema);
  const result = await getOverdue(query);

  const meta: OverdueResponseMeta = {
    ...buildPaginationMeta(query.page, query.pageSize, result.total),
    totals: result.totals,
  };

  return paginated(result.items, meta, { origin });
});
