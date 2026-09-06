/**
 * /api/expenses/[id]
 *
 * Editing or removing a recorded transaction is an ADMIN act. Both writes run
 * in a transaction with their audit row, and the deletion response says plainly
 * that the record is gone rather than archived - an expense is a leaf, nothing
 * references it.
 */
import { updateExpenseSchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseBody, parseIdParam } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { deleteExpense, updateExpense } from '@/lib/services/expense.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const PATCH = defineRoute<{ id: string }>(
  { role: 'ADMIN' },
  async ({ request, params, auth, origin }) => {
    const id = parseIdParam(params);
    const input = await parseBody(request, updateExpenseSchema);
    const expense = await updateExpense(id, input, auth);
    return ok(expense, { origin });
  },
);

export const DELETE = defineRoute<{ id: string }>(
  { role: 'ADMIN' },
  async ({ params, auth, origin }) => {
    const id = parseIdParam(params);
    const result = await deleteExpense(id, auth);
    return ok(result, { origin });
  },
);
