/**
 * GET /api/dashboard
 *
 * Everything the Overview screen renders, in one response, so the client makes
 * one request rather than eight. It is the heaviest read in the system, hence
 * the doubled rate-limit weight.
 */
import { dashboardQuerySchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseQuery } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { getDashboard } from '@/lib/services/dashboard.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute(
  { role: 'VIEWER', rateLimitWeight: 2 },
  async ({ request, origin }) => {
    const query = parseQuery(request, dashboardQuerySchema);
    const dashboard = await getDashboard(query);
    return ok(dashboard, { origin });
  },
);
