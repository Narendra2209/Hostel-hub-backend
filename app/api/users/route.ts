/**
 * /api/users
 *
 *   GET  - the account list. ADMIN can read it; the rows never carry a password
 *          hash because the service selects an explicit field list.
 *   POST - invite a colleague. OWNER only, because it hands out access.
 *
 * The temporary password in the POST response is the only time it exists
 * outside the invitee's head: it is not stored in plaintext, not audited and
 * not recoverable. Responses already carry `Cache-Control: no-store`.
 */
import { defineRoute, optionsHandler, parseBody, parseQuery } from '@/lib/http/handler';
import { buildPaginationMeta, ok, paginated } from '@/lib/http/response';
import { inviteUserSchema, paginationQuerySchema } from '@hostel/shared';
import { inviteUser, listUsers } from '@/lib/services/user.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'ADMIN' }, async ({ request, origin }) => {
  const query = parseQuery(request, paginationQuerySchema);
  const { items, total } = await listUsers(query);
  return paginated(items, buildPaginationMeta(query.page, query.pageSize, total), { origin });
});

export const POST = defineRoute(
  // Weighted: creating an invitation hashes a password.
  { role: 'OWNER', rateLimitWeight: 5 },
  async ({ request, auth, origin }) => {
    const input = await parseBody(request, inviteUserSchema);
    return ok(await inviteUser(input, auth), { origin, status: 201 });
  },
);
