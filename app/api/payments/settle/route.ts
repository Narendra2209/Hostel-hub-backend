/**
 * POST /api/payments/settle - clear a resident's outstanding balance for one
 * billing month ("Mark paid" on the overdue screen, "Full" on the fee ledger).
 *
 * The browser sends who and which month. It never sends how much: the amount is
 * the balance the fee engine derives from the ledger inside the writing
 * transaction, so a stale screen cannot over- or under-pay a month.
 */
import { settlePaymentSchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseBody } from '@/lib/http/handler';
import { created } from '@/lib/http/response';
import { settlePayment } from '@/lib/services/payment.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const POST = defineRoute({ role: 'MANAGER' }, async ({ request, auth, origin }) => {
  const input = await parseBody(request, settlePaymentSchema);
  const payment = await settlePayment(input, auth);
  return created(payment, { origin });
});
