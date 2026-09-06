/**
 * GET /api/fees - the monthly fee ledger.
 *
 * One month, every enrolled resident, with the expected/paid/balance/status the
 * fee engine derived. The screen renders these numbers; it never recomputes any
 * of them.
 */
import { feeLedgerQuerySchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseQuery } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { getFeeLedger } from '@/lib/services/fee-ledger.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'VIEWER' }, async ({ request, origin }) => {
  const query = parseQuery(request, feeLedgerQuerySchema);
  const ledger = await getFeeLedger(query);
  return ok(ledger, { origin });
});
