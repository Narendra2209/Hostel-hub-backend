/**
 * PATCH  /api/expense-categories/[id] - rename, reorder or (de)activate.
 * DELETE /api/expense-categories/[id] - owner-only. Refused while bills are
 *          filed under it; a category that was used in the past is deactivated
 *          rather than deleted, and the response says which happened.
 */
import { defineRoute, optionsHandler, parseBody, parseIdParam } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { updateExpenseCategorySchema } from '@hostel/shared';
import { deleteCategory, updateCategory } from '@/lib/services/building.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const PATCH = defineRoute<{ id: string }>(
  { role: 'ADMIN' },
  async ({ request, params, auth, origin }) => {
    const id = parseIdParam(params);
    const input = await parseBody(request, updateExpenseCategorySchema);
    return ok(await updateCategory(id, input, auth), { origin });
  },
);

export const DELETE = defineRoute<{ id: string }>(
  { role: 'OWNER' },
  async ({ params, auth, origin }) => {
    const id = parseIdParam(params);
    return ok(await deleteCategory(id, auth), { origin });
  },
);
