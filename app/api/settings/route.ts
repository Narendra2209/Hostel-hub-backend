/**
 * GET  /api/settings - the hostel's name, currency, default due day, timezone.
 * PATCH /api/settings - owner-only edit of the same.
 *
 * The settings row is bootstrapped on first read, so a freshly migrated
 * database answers this endpoint correctly without a seed script.
 */
import { defineRoute, optionsHandler, parseBody } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { updateSettingsSchema } from '@hostel/shared';
import { getSettings, toSettingsDto, updateSettings } from '@/lib/services/settings.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'VIEWER' }, async ({ origin }) => {
  const settings = await getSettings();
  return ok(toSettingsDto(settings), { origin });
});

export const PATCH = defineRoute({ role: 'OWNER' }, async ({ request, auth, origin }) => {
  const input = await parseBody(request, updateSettingsSchema);
  const settings = await updateSettings(input, auth);
  return ok(toSettingsDto(settings), { origin });
});
