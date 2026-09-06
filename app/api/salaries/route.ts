/**
 * /api/salaries - list salary payments, and record one.
 */
import { createSalaryPaymentSchema, salaryListQuerySchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseBody, parseQuery } from '@/lib/http/handler';
import { created, paginated } from '@/lib/http/response';
import { createSalaryPayment, listSalaryPayments } from '@/lib/services/salary.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'VIEWER' }, async ({ request, origin }) => {
  const query = parseQuery(request, salaryListQuerySchema);
  const { items, meta } = await listSalaryPayments(query);
  return paginated(items, meta, { origin });
});

/**
 * Paying a salary is a day-to-day transaction, so MANAGER is enough. Partial
 * payments and several payments in one month are both normal.
 */
export const POST = defineRoute({ role: 'MANAGER' }, async ({ request, auth, origin }) => {
  const input = await parseBody(request, createSalaryPaymentSchema);
  const payment = await createSalaryPayment(input, auth);
  return created(payment, { origin });
});
