/**
 * The activity log - the audit trail rendered for people rather than machines.
 *
 * `/api/audit-logs` hands back the raw rows: two blobs of JSON and a user id.
 * That is the right shape for an export or a debugger and the wrong shape for
 * the screen a DEVELOPER opens when somebody asks "who changed this, and what
 * was it before?". This service does the three things that turn one into the
 * other:
 *
 *   1. resolves the actor id to a name and a role,
 *   2. resolves the affected record to a human label,
 *   3. reduces `oldData` vs `newData` to only the fields that actually differ,
 *      formatted for display.
 *
 * WHAT IT COSTS. A page of N rows issues a fixed, small number of queries, none
 * of which grows with N:
 *
 *   1 count + 1 findMany  the page itself                      (audit.service)
 *   2 distinct commands   the filter dropdowns, index-only     (audit.service)
 *   1 findMany            EVERY actor on the page and in the dropdowns, at once
 *   <= 5 findMany         one per *entity type* present on the page, never one
 *                         per row - and only for the types whose label has to
 *                         be looked up at all (see LOOKUP_MODEL below)
 *   1 findFirst           hostel settings, for the currency symbol
 *
 * So a fifty-row page is around ten queries and a five-hundred-row page is the
 * same ten. There is no lookup inside the mapping loop anywhere in this file.
 */
import type {
  ActivityChangeDto,
  ActivityEntryDto,
  ActivityFiltersDto,
  ActivityListMeta,
  AuditEntityType,
} from '@hostel/shared';
import { formatMoney } from '@hostel/shared';
import type { AuditLog } from '@prisma/client';
import { prisma } from '../db/prisma';
import { paiseToRupees } from '../db/money';
import { buildPaginationMeta } from '../http/response';
import {
  distinctAuditActorIds,
  distinctAuditEntityTypes,
  findAuditPage,
  loadActors,
  SANITISER_MARKERS,
  type AuditActor,
  type AuditPageInput,
} from './audit.service';
import { getSettings } from './settings.service';

export type ActivityQueryInput = AuditPageInput;

export interface ActivityListResult {
  items: ActivityEntryDto[];
  meta: ActivityListMeta;
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/* ------------------------------------------------------------------ *
 * Entity labels
 * ------------------------------------------------------------------ */

/**
 * Which entity types have a record with a name of its own, worth looking up.
 *
 * The types NOT listed here - FEE_PAYMENT, SALARY_PAYMENT, EXPENSE, SETTINGS -
 * are labelled from the stored audit payload instead, and that is a deliberate
 * choice rather than a shortcut:
 *
 *  * A payment row has no name. Naming "the person the money relates to" would
 *    mean loading the payment and then loading its resident or staff member -
 *    two round trips per entity type to recover a string the payload already
 *    holds. Every writer of a payment audit row stores a DTO carrying
 *    `residentName` / `staffName` (services) or `resident` / `staff` (the legacy
 *    importer), verified against all 251 rows in the live register.
 *  * A reversed payment is *deleted*. Its row is gone, so a lookup would return
 *    nothing precisely for the entries a reversal investigation cares about
 *    most, while the payload still names the resident and the amount.
 *
 * For the types that ARE listed, the live record wins when it exists, because
 * the current name is what the reader will find if they go looking. When the
 * record has since been deleted, the payload's name is used as a fallback, and
 * only when neither knows anything is the label null - a deleted record never
 * fails the request, it just has less to say.
 */
const LOOKUP_MODEL = {
  RESIDENT: 'resident',
  BUILDING: 'building',
  STAFF: 'staff',
  EXPENSE_CATEGORY: 'expenseCategory',
  USER: 'user',
  // A SESSION row's entityId is the id of the user who signed in.
  SESSION: 'user',
} as const satisfies Partial<Record<AuditEntityType, string>>;

type LookupModel = (typeof LOOKUP_MODEL)[keyof typeof LOOKUP_MODEL];

const lookupModelFor = (entityType: string): LookupModel | undefined =>
  (LOOKUP_MODEL as Record<string, LookupModel | undefined>)[entityType];

/** Name lookups keyed by model, then by id. */
type NameIndex = Map<LookupModel, Map<string, string>>;

/**
 * One query per entity *type* present on the page, issued in parallel.
 *
 * `USER` and `SESSION` share the `user` collection, so they share one query
 * too; ids that are not ObjectIds are dropped before the query rather than
 * handed to Prisma, which would reject the whole `in` clause.
 */
async function loadEntityNames(rows: AuditLog[]): Promise<NameIndex> {
  const wanted = new Map<LookupModel, Set<string>>();

  for (const row of rows) {
    const model = lookupModelFor(row.entityType);
    if (!model || !OBJECT_ID.test(row.entityId)) continue;
    const bucket = wanted.get(model) ?? new Set<string>();
    bucket.add(row.entityId);
    wanted.set(model, bucket);
  }

  const index: NameIndex = new Map();
  if (wanted.size === 0) return index;

  const finders: Record<LookupModel, (ids: string[]) => Promise<{ id: string; name: string }[]>> = {
    resident: (ids) =>
      prisma.resident.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    building: (ids) =>
      prisma.building.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    staff: (ids) =>
      prisma.staff.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    expenseCategory: (ids) =>
      prisma.expenseCategory.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      }),
    user: (ids) =>
      prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  };

  const entries = [...wanted.entries()];
  const results = await Promise.all(entries.map(([model, ids]) => finders[model]([...ids])));

  entries.forEach(([model], position) => {
    index.set(model, new Map((results[position] ?? []).map((row) => [row.id, row.name])));
  });

  return index;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asLabel = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || SANITISER_MARKERS.has(trimmed)) return null;
  return trimmed.slice(0, 120);
};

/**
 * The name the payload itself carries, if any.
 *
 * The keys differ per writer - services store DTOs (`residentName`), the legacy
 * importer stores a flattened summary (`resident`) - so both are accepted, in
 * the order that puts the most specific first.
 */
function labelFromPayload(entityType: string, payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;

  const candidateKeys =
    entityType === 'FEE_PAYMENT'
      ? ['residentName', 'resident']
      : entityType === 'SALARY_PAYMENT'
        ? ['staffName', 'staff']
        : entityType === 'EXPENSE'
          ? ['vendor', 'categoryName', 'category']
          : entityType === 'SETTINGS'
            ? ['hostelName']
            : ['name'];

  for (const key of candidateKeys) {
    const label = asLabel(payload[key]);
    if (label) return label;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The diff
 * ------------------------------------------------------------------ */

/** Bookkeeping columns. They change on every write and mean nothing to a reader. */
const NOISE_FIELDS = new Set(['id', 'createdAt', 'updatedAt']);

/** Beyond this, one pathological row would dominate the whole response. */
const MAX_CHANGES = 25;

/** How much of a long free-text field (a note, say) is worth rendering. */
const MAX_VALUE_LENGTH = 160;

/** `monthlyFee`, `amount`, `monthlySalary`, ... */
const MONEY_FIELD = /fee|amount|salary/i;

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * THE UNIT AUDIT PAYLOADS QUOTE MONEY IN.
 *
 * The database stores integer paise, but an audit payload is not a database
 * row: every writer stores a DTO, and DTOs quote RUPEES (`toExpenseDto`,
 * `toStaffDto`, `residentDto`, `toSalaryPaymentDto` all run `paiseToRupees`
 * first). The legacy importer says so in as many words - "Audit payloads quote
 * rupees, as every DTO-derived audit entry does; the stored `monthlyFee` above
 * is the paise equivalent."
 *
 * Verified against the live register: a 4,500-rupee rent is stored as 450000 in
 * `residents.monthlyFee` and as 4500 in the audit payload. Dividing by 100 here
 * would render every amount in the activity log at one-hundredth of its value.
 *
 * It is a single constant rather than an inlined decision so that if audit
 * payloads ever start carrying raw rows, this is the one line to flip.
 */
const AUDIT_PAYLOAD_MONEY_UNIT: 'paise' | 'rupees' = 'rupees';

const isMarker = (value: unknown): boolean =>
  typeof value === 'string' && SANITISER_MARKERS.has(value);

/** Key order is not meaningful in stored JSON, so compare independently of it. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/**
 * `sanitise` drops null and undefined entirely, so a field that was cleared is
 * absent from the newer payload rather than present as null. Treating the two
 * as equal keeps "absent on both sides" from looking like a change.
 */
function sameValue(a: unknown, b: unknown): boolean {
  const aEmpty = a === undefined || a === null;
  const bEmpty = b === undefined || b === null;
  if (aEmpty || bEmpty) return aEmpty && bEmpty;
  if (typeof a !== 'object' && typeof b !== 'object') return Object.is(a, b);
  return stableStringify(a) === stableStringify(b);
}

function truncate(text: string): string {
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
}

/** Render one stored value the way the screen should show it. */
function formatValue(field: string, value: unknown, currency: string): string | null {
  if (value === undefined || value === null) return null;

  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (MONEY_FIELD.test(field)) {
      const rupees = AUDIT_PAYLOAD_MONEY_UNIT === 'paise' ? paiseToRupees(value) : value;
      return formatMoney(rupees, currency);
    }
    return String(value);
  }

  if (typeof value === 'string') {
    // Timestamps are stored in full; the activity log shows the day, which is
    // the granularity a reader is comparing at.
    if (ISO_DATE_TIME.test(value)) return value.slice(0, 10);
    if (ISO_DATE.test(value)) return value;
    return truncate(value);
  }

  return truncate(JSON.stringify(value) ?? String(value));
}

/**
 * The fields that actually differ between the two payloads.
 *
 * Returns an empty list when either side is missing, which is every CREATE,
 * DELETE and LOGIN row: there is no "before" to compare against, the whole
 * record is the change, and `ActivityEntryDto.changes` documents exactly that.
 */
export function diffPayloads(
  oldData: unknown,
  newData: unknown,
  currency: string,
): ActivityChangeDto[] {
  const before = asRecord(oldData);
  const after = asRecord(newData);
  if (!before || !after) return [];

  const changes: ActivityChangeDto[] = [];
  let overflow = 0;

  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (NOISE_FIELDS.has(field)) continue;

    const a = before[field];
    const b = after[field];

    // "[none]" -> "[stored]" is the sanitiser talking, not the user. The row's
    // summary already says a document was uploaded or removed.
    if (isMarker(a) || isMarker(b)) continue;
    if (sameValue(a, b)) continue;

    if (changes.length >= MAX_CHANGES) {
      overflow += 1;
      continue;
    }

    changes.push({
      field,
      before: formatValue(field, a, currency),
      after: formatValue(field, b, currency),
    });
  }

  if (overflow > 0) {
    changes.push({
      field: `…and ${overflow} more field${overflow === 1 ? '' : 's'} changed`,
      before: null,
      after: null,
    });
  }

  return changes;
}

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */

function toEntry(
  row: AuditLog,
  actors: Map<string, AuditActor>,
  names: NameIndex,
  currency: string,
): ActivityEntryDto {
  const actor = row.userId ? actors.get(row.userId) : undefined;
  const payload = asRecord(row.newData) ?? asRecord(row.oldData);
  const model = lookupModelFor(row.entityType);
  const looked = model ? names.get(model)?.get(row.entityId) : undefined;

  return {
    id: row.id,
    at: row.createdAt.toISOString(),
    action: row.action,
    entityType: row.entityType as AuditEntityType,
    entityId: row.entityId,
    entityLabel: asLabel(looked) ?? labelFromPayload(row.entityType, payload),
    summary: row.summary,
    actor: {
      id: row.userId,
      // A null userId is a write with no human behind it - the legacy import,
      // or a scheduled job. Naming it is more honest than an empty cell.
      name: actor?.name ?? (row.userId ? 'Deleted user' : 'System'),
      role: actor?.role ?? null,
    },
    changes: diffPayloads(row.oldData, row.newData, currency),
  };
}

/**
 * Filter options for the UI's dropdowns, derived from what is in the log rather
 * than from what the enums allow - a type nobody has ever touched should not
 * appear as a choice.
 *
 * Both distinct commands are index-only (DISTINCT_SCAN), so this does not scan
 * the collection and does not get slower as the log grows.
 */
async function loadFilterOptions(): Promise<{ entityTypes: AuditEntityType[]; actorIds: string[] }> {
  const [entityTypes, actorIds] = await Promise.all([
    distinctAuditEntityTypes(),
    distinctAuditActorIds(),
  ]);
  return { entityTypes: entityTypes as AuditEntityType[], actorIds };
}

export async function listActivity(query: ActivityQueryInput): Promise<ActivityListResult> {
  const [{ rows, total }, options, settings] = await Promise.all([
    findAuditPage(query),
    loadFilterOptions(),
    getSettings(),
  ]);

  /*
   * One user query serves both the page's actors and the dropdown's options.
   * The union matters: a row written between the `distinct` and the page read
   * would otherwise carry an actor the dropdown has never heard of, and its
   * name would be missing from a page that is otherwise correct.
   */
  const [actors, names] = await Promise.all([
    loadActors([...options.actorIds, ...rows.map((row) => row.userId)]),
    loadEntityNames(rows),
  ]);

  const filters: ActivityFiltersDto = {
    entityTypes: options.entityTypes,
    actors: options.actorIds
      .map((id) => ({ id, name: actors.get(id)?.name ?? 'Deleted user' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };

  return {
    items: rows.map((row) => toEntry(row, actors, names, settings.currency)),
    meta: {
      ...buildPaginationMeta(query.page, query.pageSize, total),
      filters,
    },
  };
}
