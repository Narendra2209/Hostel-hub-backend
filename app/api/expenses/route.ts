/**
 * /api/expenses - the "Bills & expenses" screen.
 *
 * The list meta carries totals for the entire filtered set, not the page on
 * screen, so the stat cards stay correct while the manager pages through.
 */
import type { ExpenseListMeta } from '@hostel/shared';
import { createExpenseSchema, expenseListQuerySchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseBody, parseQuery } from '@/lib/http/handler';
import { buildPaginationMeta, created, paginated } from '@/lib/http/response';
import { createExpense, listExpenses } from '@/lib/services/expense.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'VIEWER' }, async ({ request, origin }) => {
  const query = parseQuery(request, expenseListQuerySchema);
  const { items, total, totals } = await listExpenses(query);

  const meta: ExpenseListMeta = {
    ...buildPaginationMeta(query.page, query.pageSize, total),
    totals,
  };

  return paginated(items, meta, { origin });
});

export const POST = defineRoute({ role: 'MANAGER' }, async ({ request, auth, origin }) => {
  const input = await parseBody(request, createExpenseSchema);
  const expense = await createExpense(input, auth);
  return created(expense, { origin });
});
