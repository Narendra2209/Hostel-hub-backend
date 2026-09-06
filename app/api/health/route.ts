/**
 * GET /api/health
 *
 * The only genuinely public endpoint. It is what a load balancer or container
 * health check polls, so it reports the one dependency that makes the API
 * useful - MongoDB - and answers 503 when that is unreachable. The body
 * shape is identical either way so a human curling it always gets the detail.
 */
import { defineRoute, optionsHandler } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { checkDatabaseConnection } from '@/lib/db/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

interface HealthDto {
  status: 'ok' | 'degraded';
  database: boolean;
  timestamp: string;
}

export const GET = defineRoute({ allowAnonymous: true }, async ({ origin }) => {
  const database = await checkDatabaseConnection();
  const body: HealthDto = {
    status: database ? 'ok' : 'degraded',
    database,
    timestamp: new Date().toISOString(),
  };
  return ok(body, { origin, status: database ? 200 : 503 });
});
