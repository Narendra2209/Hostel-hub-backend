/**
 * /api/export/residents - a copy of the resident register as CSV (default) or
 * JSON. A data-portability export of database records, not a backup: the
 * hostel database remains the only source of truth.
 */
import { exportQuerySchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseQuery } from '@/lib/http/handler';
import { fileDownload } from '@/lib/http/response';
import { exportResidents } from '@/lib/services/export.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'ADMIN', rateLimitWeight: 5 }, async ({ request, origin }) => {
  const query = parseQuery(request, exportQuerySchema);
  const file = await exportResidents(query);
  return fileDownload(file.body, file.fileName, file.contentType, { origin });
});
