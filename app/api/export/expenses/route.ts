/**
 * /api/export/expenses - the running-cost register as CSV (default) or JSON.
 * Unattributed bills export with the building column reading "Shared".
 */
import { exportQuerySchema } from '@hostel/shared';
import { defineRoute, optionsHandler, parseQuery } from '@/lib/http/handler';
import { fileDownload } from '@/lib/http/response';
import { exportExpenses } from '@/lib/services/export.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

export const GET = defineRoute({ role: 'ADMIN', rateLimitWeight: 5 }, async ({ request, origin }) => {
  const query = parseQuery(request, exportQuerySchema);
  const file = await exportExpenses(query);
  return fileDownload(file.body, file.fileName, file.contentType, { origin });
});
