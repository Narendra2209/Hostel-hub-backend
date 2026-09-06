/**
 * /api/payments - list and record fee payments.
 */
import { createPaymentSchema, paymentListQuerySchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseBody, parseQuery } from '@/lib/http/handler';
import { created, paginated } from '@/lib/http/response';
import { createPayment, listPayments } from '@/lib/services/payment.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'VIEWER' }, async ({ request, origin }) => {
  const query = parseQuery(request, paymentListQuerySchema);
  const { items, meta } = await listPayments(query);
  return paginated(items, meta, { origin });
});

/**
 * Recording money in is a day-to-day transaction, so MANAGER is enough.
 * Several payments may target one billing month; each one is its own row.
 */
export const POST = defineRoute({ role: 'MANAGER' }, async ({ request, auth, origin }) => {
  const input = await parseBody(request, createPaymentSchema);
  const payment = await createPayment(input, auth);
  return created(payment, { origin });
});
