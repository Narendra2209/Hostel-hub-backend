/**
 * GET /api/activity
 *
 * "Who changed what." The same rows /api/audit-logs serves, resolved into
 * names and reduced to the fields that actually differ - see
 * lib/services/activity.service.ts for the shape and its query budget.
 *
 * Guarded by CAPABILITY, not by rank. DEVELOPER shares ADMIN's rank, so
 * `requireRole(auth, 'ADMIN')` would happen to admit it today - but only by
 * coincidence, and it would also admit a future role that reached rank 2 for
 * unrelated reasons. `requireCapability(auth, 'activityLog')` says what is
 * actually being asked: may this account see the record of who changed what.
 */
import { activityQuerySchema } from '@hostel/shared';
import { requireCapability } from '@/lib/auth/context';
import { defineRoute, optionsHandler, parseQuery } from '@/lib/http/handler';
import { paginated } from '@/lib/http/response';
import { listActivity } from '@/lib/services/activity.service';
import { normaliseAuditAction, normaliseAuditEntityType } from '@/lib/services/audit.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ rateLimitWeight: 2 }, async ({ request, auth, origin }) => {
  requireCapability(auth, 'activityLog');

  const query = parseQuery(request, activityQuerySchema);

  const { items, meta } = await listActivity({
    page: query.page,
    pageSize: query.pageSize,
    sortOrder: query.sortOrder,
    entityType: normaliseAuditEntityType(query.entityType),
    entityId: query.entityId,
    userId: query.actorId,
    action: normaliseAuditAction(query.action),
    from: query.from,
    to: query.to,
    search: query.search,
  });

  return paginated(items, meta, { origin });
});
