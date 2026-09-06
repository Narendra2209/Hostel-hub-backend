/**
 * GET  /api/expense-categories - the categories the bills screen files against.
 * POST /api/expense-categories - add one.
 *
 * The eight defaults are created idempotently on first read, so this endpoint
 * is never empty on a virgin database. Pass `?includeInactive=true` to see
 * categories that were retired but kept for their history.
 */
import { defineRoute, optionsHandler, parseBody, parseQuery } from '@/lib/http/handler';
import { created, ok } from '@/lib/http/response';
import { createExpenseCategorySchema } from '@hostel/shared';
import { listCategories } from '@/lib/services/settings.service';
import { categoryListQuerySchema, createCategory } from '@/lib/services/building.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'VIEWER' }, async ({ request, origin }) => {
  const query = parseQuery(request, categoryListQuerySchema);
  return ok(await listCategories({ includeInactive: query.includeInactive }), { origin });
});

export const POST = defineRoute({ role: 'ADMIN' }, async ({ request, auth, origin }) => {
  const input = await parseBody(request, createExpenseCategorySchema);
  return created(await createCategory(input, auth), { origin });
});
