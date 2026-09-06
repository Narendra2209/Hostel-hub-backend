/**
 * GET /api/audit-logs
 *
 * The administrative trail: who changed what, when. Rows are written inside the
 * same transaction as the change they describe, so this list is authoritative.
 * This endpoint returns the RAW rows, `oldData`/`newData` included; /api/activity
 * serves the same records rendered for a human reader.
 *
 * Guarded by capability rather than by rank. It used to require ADMIN, which
 * expressed the right intent when there were four roles - but DEVELOPER exists
 * precisely to answer "who changed this?" and shares ADMIN's rank rather than
 * exceeding it, so the guard now names the capability instead of a rank that
 * happens to imply it. OWNER, ADMIN and DEVELOPER pass; MANAGER and VIEWER do
 * not, exactly as before.
 */
import { auditLogQuerySchema } from '@hostel/shared';
import { requireCapability } from '@/lib/auth/context';
import { defineRoute, optionsHandler, parseQuery } from '@/lib/http/handler';
import { paginated } from '@/lib/http/response';
import { listAuditLogs, normaliseAuditEntityType } from '@/lib/services/audit.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({}, async ({ request, auth, origin }) => {
  requireCapability(auth, 'activityLog');

  const query = parseQuery(request, auditLogQuerySchema);
  const { items, meta } = await listAuditLogs({
    page: query.page,
    pageSize: query.pageSize,
    entityType: normaliseAuditEntityType(query.entityType),
    entityId: query.entityId,
    userId: query.userId,
    sortOrder: query.sortOrder,
  });
  return paginated(items, meta, { origin });
});
