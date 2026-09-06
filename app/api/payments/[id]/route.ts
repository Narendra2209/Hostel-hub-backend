/**
 * /api/payments/[id] - read, edit and reverse one fee payment.
 */
import { updatePaymentSchema } from '@hostel/shared';
import {
  defineRoute,
  optionsHandler,
  parseBody,
  parseIdParam,
} from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { deletePayment, getPayment, updatePayment } from '@/lib/services/payment.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute<{ id: string }>({ role: 'VIEWER' }, async ({ params, origin }) => {
  const id = parseIdParam(params);
  const payment = await getPayment(id);
  return ok(payment, { origin });
});

/** Editing a recorded transaction is an ADMIN action, not a day-to-day one. */
export const PATCH = defineRoute<{ id: string }>(
  { role: 'ADMIN' },
  async ({ request, params, auth, origin }) => {
    const id = parseIdParam(params);
    const input = await parseBody(request, updatePaymentSchema);
    const payment = await updatePayment(id, input, auth);
    return ok(payment, { origin });
  },
);

/**
 * The reference UI's "Undo". The row is genuinely removed - a cancelled payment
 * that lingered would distort every balance the fee engine derives - but the
 * whole record is written to the audit log in the same transaction, so the
 * money is never silently gone.
 */
export const DELETE = defineRoute<{ id: string }>(
  { role: 'ADMIN' },
  async ({ params, auth, origin }) => {
    const id = parseIdParam(params);
    const result = await deletePayment(id, auth);
    return ok(result, { origin });
  },
);
