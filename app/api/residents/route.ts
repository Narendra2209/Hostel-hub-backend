/**
 * /api/residents - the roster.
 *
 * GET returns one page of residents already priced for the selected month, so
 * the table never has to ask a second endpoint what anybody owes. The service
 * builds the ResidentListMeta (pagination plus month, stayingCount and
 * totalOnRecord) that the list header renders.
 */
import { createResidentSchema, residentListQuerySchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseBody, parseQuery } from '@/lib/http/handler';
import { created, paginated } from '@/lib/http/response';
import { createResident, listResidents } from '@/lib/services/resident.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'VIEWER' }, async ({ request, origin }) => {
  const query = parseQuery(request, residentListQuerySchema);
  const { items, meta } = await listResidents(query);
  return paginated(items, meta, { origin });
});

/** Creating a resident is a record-management action, so ADMIN and above. */
export const POST = defineRoute({ role: 'ADMIN' }, async ({ request, auth, origin }) => {
  const input = await parseBody(request, createResidentSchema);
  const resident = await createResident(input, auth);
  return created(resident, { origin });
});
