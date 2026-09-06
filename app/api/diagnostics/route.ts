/**
 * GET /api/diagnostics
 *
 * Database storage, this container's runtime, its caches and its slowest
 * routes. OWNER and DEVELOPER only - `canViewDiagnostics` is deliberately
 * narrower than the activity log's capability, because knowing the shape of the
 * deployment is a different question from knowing who edited a resident.
 *
 * The response is `no-store`: every number in it describes the instant it was
 * generated, and a cached copy would be actively misleading to somebody
 * watching memory climb.
 */
import { requireCapability } from '@/lib/auth/context';
import { defineRoute, optionsHandler } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { collectDiagnostics } from '@/lib/services/diagnostics.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ rateLimitWeight: 2 }, async ({ auth, origin }) => {
  requireCapability(auth, 'diagnostics');
  const diagnostics = await collectDiagnostics();
  return ok(diagnostics, { origin, headers: { 'Cache-Control': 'no-store' } });
});
