/**
 * /api/residents/[id]/vacate - record that a resident is leaving.
 *
 * The vacating month is billed in full, so the stored `vacatedDate` is that
 * month's last day and the fee engine keeps charging up to and including it.
 */
import { vacateResidentSchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseBody, parseIdParam } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { vacateResident } from '@/lib/services/resident.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const POST = defineRoute<{ id: string }>(
  { role: 'ADMIN' },
  async ({ request, params, auth, origin }) => {
    const id = parseIdParam(params);
    const input = await parseBody(request, vacateResidentSchema);
    const resident = await vacateResident(id, input, auth);
    return ok(resident, { origin });
  },
);
