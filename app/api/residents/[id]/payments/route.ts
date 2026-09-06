/**
 * /api/residents/[id]/payments - one resident's payment history, paginated.
 *
 * The same filters as the global payment list, minus `residentId`, which the
 * path already names.
 */
import { defineRoute, optionsHandler, parseIdParam, parseQuery } from '@/lib/http/handler';
import { paginated } from '@/lib/http/response';
import {
  listResidentPayments,
  residentPaymentListQuerySchema,
} from '@/lib/services/resident.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute<{ id: string }>(
  { role: 'VIEWER' },
  async ({ request, params, origin }) => {
    const id = parseIdParam(params);
    const query = parseQuery(request, residentPaymentListQuerySchema);
    const { items, meta } = await listResidentPayments(id, query);
    return paginated(items, meta, { origin });
  },
);
