/**
 * /api/salaries/settle - the register's "Full" button.
 *
 * The browser sends only the staff member and the month; the server works out
 * `monthlySalary - already paid` and inserts exactly that, inside the same
 * transaction that read it.
 */
import { settleSalarySchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseBody } from '@/lib/http/handler';
import { created } from '@/lib/http/response';
import { settleSalary } from '@/lib/services/salary.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const POST = defineRoute({ role: 'MANAGER' }, async ({ request, auth, origin }) => {
  const input = await parseBody(request, settleSalarySchema);
  const payment = await settleSalary(input, auth);
  return created(payment, { origin });
});
