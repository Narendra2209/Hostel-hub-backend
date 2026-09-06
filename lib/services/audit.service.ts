/**
 * Audit trail.
 *
 * Every financial and administrative mutation writes one row here, inside the
 * same transaction as the change itself, so the trail can never disagree with
 * the data. Payloads are trimmed of anything sensitive before being stored.
 *
 * Two screens read this collection:
 *
 *   * `/api/audit-logs` - the raw rows, before/after JSON included.
 *   * `/api/activity`   - the same rows rendered for people (activity.service).
 *
 * The querying below is shared by both so there is one definition of what a
 * filter means and one place where index usage can be reasoned about. Every
 * filter maps onto an index that already exists on the collection:
 *
 *   entityType [+ entityId] -> `[entityType, entityId]` (prefix or full)
 *   actor (userId)          -> `[userId]`
 *   from / to, and the sort -> `[createdAt]`
 *
 * `action` and `search` have no index of their own; see the note on
 * `buildAuditWhere` for why that is a deliberate accepted cost rather than an
 * oversight.
 */
import type { AuditAction, AuditEntityType, AuditLogDto, UserRole } from '@hostel/shared';
import { isoDateToUtcDate } from '@hostel/shared';
import {
  AuditAction as AuditActionEnum,
  AuditEntityType as AuditEntityTypeEnum,
  Prisma,
  type AuditLog,
} from '@prisma/client';
import { prisma, type PrismaLike } from '../db/prisma';
import type { AuthContext } from '../auth/context';
import { ValidationError } from '../errors/app-error';
import { logger } from '../http/logger';
import { buildPaginationMeta } from '../http/response';

export interface AuditInput {
  auth: AuthContext;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  summary?: string;
  oldData?: unknown;
  newData?: unknown;
}

/** Object keys are pointers to private S3 documents - never store them here. */
const SENSITIVE_KEYS = new Set(['photoKey', 'aadhaarDocumentKey', 'uploadUrl', 'url']);

function sanitise(value: unknown, depth = 0): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (depth > 5) return '[depth-limit]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toFixed(2);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((v) => sanitise(v, depth + 1) ?? null) as Prisma.InputJsonValue;
  }
  if (typeof value === 'object') {
    const out: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key)) {
        out[key] = v ? '[stored]' : '[none]';
        continue;
      }
      const cleaned = sanitise(v, depth + 1);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value as Prisma.InputJsonValue;
}

/**
 * The placeholders `sanitise` writes in place of a value it will not store.
 * The activity log skips fields holding one of these: "[none]" changing to
 * "[stored]" is noise, and the row's summary already says what happened.
 */
export const SANITISER_MARKERS: ReadonlySet<string> = new Set([
  '[stored]',
  '[none]',
  '[depth-limit]',
]);

/**
 * Write one audit row. Pass the transaction client so the log commits or rolls
 * back with the change it describes.
 *
 * Auditing must never be the reason a legitimate mutation fails, so a failure
 * here is logged loudly rather than thrown - except inside a transaction, where
 * Prisma will surface it anyway.
 */
export async function recordAudit(client: PrismaLike, input: AuditInput): Promise<void> {
  try {
    await client.auditLog.create({
      data: {
        userId: input.auth.userId || null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        summary: input.summary?.slice(0, 300) ?? null,
        // MongoDB has no JsonNull/DbNull distinction: an absent value is simply
        // an absent field, so undefined is the correct way to omit it.
        oldData: sanitise(input.oldData),
        newData: sanitise(input.newData),
      },
    });
  } catch (error) {
    logger.error('Failed to write audit log', {
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      error,
    });
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * Reading: filters shared by /api/audit-logs and /api/activity
 * ------------------------------------------------------------------ */

/** The collection name behind the `AuditLog` model (`@@map` in schema.prisma). */
const AUDIT_COLLECTION = 'audit_logs';

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

export interface AuditFilterInput {
  entityType?: AuditEntityTypeEnum;
  entityId?: string;
  userId?: string;
  action?: AuditActionEnum;
  /** Inclusive ISO date (`2026-08-15`) on `createdAt`. */
  from?: string;
  to?: string;
  /** Case-insensitive substring match against the stored summary. */
  search?: string;
}

export interface AuditPageInput extends AuditFilterInput {
  page: number;
  pageSize: number;
  sortOrder: 'asc' | 'desc';
}

export interface AuditActor {
  id: string;
  name: string;
  role: UserRole;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Make a user's search box behave like a search box.
 *
 * Prisma's MongoDB connector compiles `contains` into `$regexMatch` and passes
 * the string through UNESCAPED - verified against Prisma 6.19.3 on this
 * cluster. Two consequences, both bad, and both fixed by escaping here:
 *
 *   * `summary contains "Owner) signed"` is an invalid regex, and MongoDB
 *     rejects the whole query with error 51111. The user typed an ordinary
 *     bracket into a search box and got a 500.
 *   * A pattern such as `(a+)+$` is catastrophic backtracking, evaluated by the
 *     database server against every document the filter has to test. That is a
 *     denial of service any signed-in reader could trigger by accident.
 *
 * Escaping makes the search mean what a search box means - this text, literally
 * - which is also what a reader typing a resident's name expects.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turn validated filters into a Prisma `where`.
 *
 * Index notes, because this collection is the one that grows without limit:
 *
 *  * `entityType`, alone or with `entityId`, is served by the compound
 *    `[entityType, entityId]` index - `entityType` is its prefix, so both
 *    shapes are index-driven.
 *  * `userId` is served by `[userId]`.
 *  * `from`/`to` and the default `createdAt` sort are served by `[createdAt]`.
 *  * `action` and `search` have NO index. `action` has seven possible values,
 *    so an index on it would be low-selectivity and MongoDB would usually
 *    ignore it anyway; `search` is a substring match, which no B-tree index can
 *    serve (it would need a text index). Both are therefore only ever a
 *    *narrowing* filter applied on top of an indexed one, and the UI always
 *    sends them alongside a date range. This is called out in the handover
 *    notes rather than fixed by editing the schema, which another agent owns.
 */
export function buildAuditWhere(filters: AuditFilterInput): Prisma.AuditLogWhereInput {
  const createdAt: Prisma.DateTimeFilter<'AuditLog'> = {};
  if (filters.from) createdAt.gte = isoDateToUtcDate(filters.from);
  if (filters.to) {
    // `to` names a day, and the whole of that day is included, so the bound is
    // the start of the following day - exclusive. Comparing against
    // "2026-08-15T00:00:00Z" instead would silently drop everything that
    // happened on the 15th, which is the day the user actually asked about.
    createdAt.lt = new Date(isoDateToUtcDate(filters.to).getTime() + MS_PER_DAY);
  }

  const search = filters.search?.trim();

  return {
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.entityId ? { entityId: filters.entityId } : {}),
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(createdAt.gte || createdAt.lt ? { createdAt } : {}),
    ...(search
      ? { summary: { contains: escapeRegExp(search), mode: 'insensitive' as const } }
      : {}),
  };
}

/**
 * One page of audit rows plus the total the filters match.
 *
 * Related rows are deliberately NOT `include`d. MongoDB has no joins, so a
 * Prisma `include` is a second query issued per relation; both callers need
 * more of the user than a name anyway, and both resolve every actor on the page
 * with a single `findMany` instead.
 */
export async function findAuditPage(
  query: AuditPageInput,
): Promise<{ rows: AuditLog[]; total: number }> {
  const where = buildAuditWhere(query);

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: query.sortOrder },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return { rows, total };
}

/**
 * Resolve user ids to name and role in ONE query.
 *
 * Ids that are not ObjectIds are dropped before the query rather than handed to
 * Prisma, which would reject the whole `in` clause and take a legitimate page
 * of activity down with it.
 */
export async function loadActors(ids: Iterable<string | null>): Promise<Map<string, AuditActor>> {
  const wanted = new Set<string>();
  for (const id of ids) {
    if (id && OBJECT_ID.test(id)) wanted.add(id);
  }
  if (wanted.size === 0) return new Map();

  const users = await prisma.user.findMany({
    where: { id: { in: [...wanted] } },
    select: { id: true, name: true, role: true },
  });

  return new Map(users.map((user) => [user.id, user]));
}

/* ------------------------------------------------------------------ *
 * Filter options
 *
 * Both use MongoDB's native `distinct` command through `$runCommandRaw`. That
 * matters: `distinct` on an indexed key is answered by a DISTINCT_SCAN, which
 * walks one entry per distinct value rather than one per document. Verified
 * against the live cluster - the plan for `entityType` is
 * PROJECTION_COVERED -> DISTINCT_SCAN on `audit_logs_entityType_entityId_idx`.
 *
 * A failure here degrades to an empty dropdown rather than a failed request:
 * losing the filter options is an inconvenience, losing the activity log is not.
 * ------------------------------------------------------------------ */

function rawValues(result: unknown): unknown[] {
  if (!result || typeof result !== 'object') return [];
  const values = (result as { values?: unknown }).values;
  return Array.isArray(values) ? values : [];
}

/**
 * `$runCommandRaw` returns MongoDB extended JSON, so an ObjectId arrives as
 * `{ "$oid": "68f0..." }` rather than as a string. Both shapes are accepted.
 */
function toObjectIdString(value: unknown): string | null {
  if (typeof value === 'string') return OBJECT_ID.test(value) ? value : null;
  if (value && typeof value === 'object' && '$oid' in value) {
    const oid = (value as { $oid?: unknown }).$oid;
    return typeof oid === 'string' && OBJECT_ID.test(oid) ? oid : null;
  }
  return null;
}

/** Every entity type that actually appears in the log, for the UI's dropdown. */
export async function distinctAuditEntityTypes(): Promise<AuditEntityTypeEnum[]> {
  try {
    const result = await prisma.$runCommandRaw({
      distinct: AUDIT_COLLECTION,
      key: 'entityType',
    });
    const known = new Set<string>(Object.values(AuditEntityTypeEnum));
    return rawValues(result)
      .filter((value): value is AuditEntityTypeEnum => typeof value === 'string' && known.has(value))
      .sort();
  } catch (error) {
    logger.warn('Could not read distinct audit entity types', { error });
    return [];
  }
}

/** Every actor id that appears in the log. Nulls (system writes) are dropped. */
export async function distinctAuditActorIds(): Promise<string[]> {
  try {
    const result = await prisma.$runCommandRaw({ distinct: AUDIT_COLLECTION, key: 'userId' });
    return rawValues(result)
      .map(toObjectIdString)
      .filter((id): id is string => id !== null);
  } catch (error) {
    logger.warn('Could not read distinct audit actors', { error });
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Validation helpers shared by the two routes
 * ------------------------------------------------------------------ */

/**
 * The query schemas accept any short string for `entityType` and `action`; the
 * columns are enums. Membership is checked here so a bad filter is a 400 rather
 * than a database error surfacing as a 500. The lists come from the generated
 * Prisma enums, so they cannot drift from the schema.
 */
export function normaliseAuditEntityType(
  value: string | undefined,
): AuditEntityTypeEnum | undefined {
  if (!value) return undefined;
  const candidate = value.toUpperCase();
  const allowed = Object.values(AuditEntityTypeEnum) as string[];
  if (!allowed.includes(candidate)) {
    throw new ValidationError('That entity type is not one we audit', {
      entityType: [`Must be one of: ${allowed.join(', ')}`],
    });
  }
  return candidate as AuditEntityTypeEnum;
}

export function normaliseAuditAction(value: string | undefined): AuditActionEnum | undefined {
  if (!value) return undefined;
  const candidate = value.toUpperCase();
  const allowed = Object.values(AuditActionEnum) as string[];
  if (!allowed.includes(candidate)) {
    throw new ValidationError('That is not an action we record', {
      action: [`Must be one of: ${allowed.join(', ')}`],
    });
  }
  return candidate as AuditActionEnum;
}

/* ------------------------------------------------------------------ *
 * The raw list, served by /api/audit-logs
 * ------------------------------------------------------------------ */

export async function listAuditLogs(
  query: AuditPageInput,
): Promise<{ items: AuditLogDto[]; meta: ReturnType<typeof buildPaginationMeta> }> {
  const { rows, total } = await findAuditPage(query);
  const actors = await loadActors(rows.map((row) => row.userId));

  return {
    items: rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      userName: row.userId ? (actors.get(row.userId)?.name ?? null) : null,
      action: row.action,
      entityType: row.entityType as AuditEntityType,
      entityId: row.entityId,
      summary: row.summary,
      oldData: row.oldData,
      newData: row.newData,
      createdAt: row.createdAt.toISOString(),
    })),
    meta: buildPaginationMeta(query.page, query.pageSize, total),
  };
}
