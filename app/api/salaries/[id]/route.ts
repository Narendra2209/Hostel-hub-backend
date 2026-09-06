/**
 * /api/salaries/[id] - correct or reverse a salary payment.
 */
import { updateSalaryPaymentSchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseBody, parseIdParam } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { deleteSalaryPayment, updateSalaryPayment } from '@/lib/services/salary.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

/** Editing a recorded transaction is an ADMIN action. */
export const PATCH = defineRoute<{ id: string }>(
  { role: 'ADMIN' },
  async ({ request, params, auth, origin }) => {
    const id = parseIdParam(params);
    const input = await parseBody(request, updateSalaryPaymentSchema);
    const payment = await updateSalaryPayment(id, input, auth);
    return ok(payment, { origin });
  },
);

/**
 * The register's undo. A salary payment owns no dependent records, so this is a
 * real delete; the audit row keeps the reversed amount on file.
 */
export const DELETE = defineRoute<{ id: string }>(
  { role: 'ADMIN' },
  async ({ params, auth, origin }) => {
    const id = parseIdParam(params);
    const result = await deleteSalaryPayment(id, auth);
    return ok(result, { origin });
  },
);
