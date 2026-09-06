/**
 * /api/staff - the salary register for a month, and adding a staff member.
 */
import { createStaffSchema, staffListQuerySchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseBody, parseQuery } from '@/lib/http/handler';
import { created, paginated } from '@/lib/http/response';
import { createStaff, listStaffLedger } from '@/lib/services/staff.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

/**
 * One row per staff member with that month's salary / paid / balance / status.
 * `meta` carries the pagination plus the payroll totals for the whole filter,
 * so the stat cards do not change as the user pages through the register.
 */
export const GET = defineRoute({ role: 'VIEWER' }, async ({ request, origin }) => {
  const query = parseQuery(request, staffListQuerySchema);
  const { rows, meta } = await listStaffLedger(query);
  return paginated(rows, meta, { origin });
});

/** Creating a person is a record change, not a day-to-day transaction. */
export const POST = defineRoute({ role: 'ADMIN' }, async ({ request, auth, origin }) => {
  const input = await parseBody(request, createStaffSchema);
  const staff = await createStaff(input, auth);
  return created(staff, { origin });
});
