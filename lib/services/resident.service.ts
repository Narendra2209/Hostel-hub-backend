/**
 * Resident business rules.
 *
 * This service owns the resident lifecycle - joining, editing, moving between
 * buildings, vacating and archiving - and the read models the residents list and
 * the profile page render.
 *
 * Two invariants shape everything below:
 *
 *  1. **No financial rule is implemented here.** Expected amounts, balances,
 *     statuses, due dates and arrears all come from `fee-engine.ts`. This file
 *     only decides *which* residents and *which* months to ask it about.
 *  2. **No query ever runs inside a per-resident loop.** A list page issues its
 *     counts and its page query, then a single `loadRosterWithLedger` call for
 *     the residents on that page; the engine then walks an in-memory index.
 *
 * Date semantics, fixed once so every screen agrees:
 *   joinMonth    -> joinDate    = FIRST day of that month (billing starts there)
 *   vacatedMonth -> vacatedDate = LAST day of that month (billed for it in full)
 */
import { z } from 'zod';
import type {
  FeePaymentDto,
  FeeStatusStripDto,
  MonthFeeStatusDto,
  MonthKey,
  OverdueSummaryDto,
  PaginationMeta,
  ResidentDto,
  ResidentListMeta,
  ResidentListRowDto,
  ResidentMoveDto,
  ResidentProfileDto,
} from '@hostel/shared';
import {
  createResidentSchema,
  feeStatusBatchQuerySchema,
  feeStatusQuerySchema,
  firstDayOfMonth,
  isoDateToUtcDate,
  lastDayOfMonth,
  monthBuildingQuerySchema,
  moveResidentSchema,
  paymentListQuerySchema,
  residentListQuerySchema,
  updateResidentSchema,
  utcDateToMonthKey,
  vacateResidentSchema,
} from '@hostel/shared';
import { prisma, runInTransaction, type PrismaLike } from '../db/prisma';
import { paiseToRupees, rupeesToPaise } from '../db/money';
import { buildPaginationMeta } from '../http/response';
import {
  ConflictError,
  ValidationError,
  buildingNotFound,
  residentNotFound,
} from '../errors/app-error';
import { requireRole, type AuthContext } from '../auth/context';
import { recordAudit } from './audit.service';
import { getFeeContext } from './settings.service';
import { loadRosterWithLedger } from './roster.service';
import {
  billableMonths,
  monthPosition,
  residentArrears,
  toMonthFeeStatusDto,
  toOverdueSummaryDto,
  yearStrip,
  type FeeContext,
  type FeeResident,
} from './fee-engine';
import { toFeePaymentDto, toResidentDto, toResidentMoveDto } from './mappers';
import {
  aggregateResidentPayments,
  asStripFeeResident,
  countResidentPayments,
  countResidents,
  createMoveRow,
  createResidentRow,
  findBuildingById,
  findResidentById,
  findResidentPage,
  findResidentPaymentPage,
  hardDeleteResident,
  listAllResidentPayments,
  listResidentMoves,
  loadYearStripRoster,
  paymentOrderBy,
  residentListWhere,
  residentOrderBy,
  residentPaymentWhere,
  residentScopeWhere,
  residentStatusWhere,
  updateResidentRow,
  type ResidentRecord,
  type ResidentRow,
  type UpdateResidentData,
} from '../repositories/resident.repository';

/* ------------------------------------------------------------------ *
 * Query types
 * ------------------------------------------------------------------ */

export type ResidentListQuery = z.infer<typeof residentListQuerySchema>;
export type ResidentProfileQuery = z.infer<typeof monthBuildingQuerySchema>;
export type FeeStatusQuery = z.infer<typeof feeStatusQuerySchema>;
export type FeeStatusBatchQuery = z.infer<typeof feeStatusBatchQuerySchema>;

/** The payment list filters, minus the resident the path already names. */
export const residentPaymentListQuerySchema = paymentListQuerySchema.omit({ residentId: true });
export type ResidentPaymentListQuery = z.infer<typeof residentPaymentListQuerySchema>;

export type CreateResidentInput = z.infer<typeof createResidentSchema>;
export type UpdateResidentInput = z.infer<typeof updateResidentSchema>;
export type MoveResidentInput = z.infer<typeof moveResidentSchema>;
export type VacateResidentInput = z.infer<typeof vacateResidentSchema>;

export interface ResidentDeletionResult {
  /** true when financial history forced a soft archive instead of a delete. */
  archived: boolean;
  resident: ResidentDto;
}

export interface ResidentMoveResult {
  resident: ResidentDto;
  move: ResidentMoveDto;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** What a row looks like when the caller asked us not to price the month. */
const emptyMonthStatus = (month: MonthKey): MonthFeeStatusDto => ({
  month,
  expected: 0,
  paid: 0,
  balance: 0,
  status: 'NOT_STAYING',
  dueDate: null,
  daysOverdue: 0,
  paymentCount: 0,
});

const EMPTY_OVERDUE: OverdueSummaryDto = {
  totalOverdue: 0,
  oldestUnpaidMonth: null,
  numberOfOverdueMonths: 0,
  maxDaysOverdue: 0,
};

/** joinMonth -> the first day of that month, at UTC midnight. */
const joinDateFromMonth = (month: MonthKey): Date => isoDateToUtcDate(firstDayOfMonth(month));

/** vacatedMonth -> the last day of that month, so the whole month is billed. */
const vacatedDateFromMonth = (month: MonthKey): Date => isoDateToUtcDate(lastDayOfMonth(month));

function assertVacatedAfterJoin(joinMonth: MonthKey, vacatedMonth: MonthKey | null): void {
  if (vacatedMonth && vacatedMonth < joinMonth) {
    throw new ValidationError('Some of the details need fixing', {
      vacatedMonth: ['Vacated month cannot be before the joining month'],
    });
  }
}

/**
 * Load a resident or fail with the domain 404.
 * Exported because several other domains (payments, uploads, exports) need the
 * same guarantee before they touch a resident's records.
 */
export async function getResidentOr404(
  id: string,
  client: PrismaLike = prisma,
): Promise<ResidentRecord> {
  const resident = await findResidentById(id, client);
  if (!resident) throw residentNotFound();
  return resident;
}

/** The resident DTO, with `vacated` resolved against the real current month. */
const residentDto = (resident: ResidentRecord | ResidentRow, context: FeeContext): ResidentDto =>
  toResidentDto(resident, { currentMonth: context.currentMonth });

/* ------------------------------------------------------------------ *
 * List
 * ------------------------------------------------------------------ */

/**
 * The residents table.
 *
 * Pagination happens in the database; the fee derivation happens afterwards and
 * only for the rows on the page, from a single roster+ledger load.
 */
export async function listResidents(
  query: ResidentListQuery,
): Promise<{ items: ResidentListRowDto[]; meta: ResidentListMeta }> {
  const { context } = await getFeeContext();
  const month = query.month ?? context.currentMonth;

  const scope = { buildingId: query.buildingId, search: query.search };
  const scopeWhere = residentScopeWhere(scope);
  const where = residentListWhere(scope, query.status, context.currentMonth);

  const [total, rows, stayingCount, totalOnRecord] = await Promise.all([
    countResidents(where),
    findResidentPage(
      where,
      residentOrderBy(query.sortBy, query.sortOrder),
      query.page,
      query.pageSize,
    ),
    countResidents({
      AND: [scopeWhere, residentStatusWhere('staying', context.currentMonth)],
    }),
    countResidents(scopeWhere),
  ]);

  const meta: ResidentListMeta = {
    ...buildPaginationMeta(query.page, query.pageSize, total),
    month,
    stayingCount,
    totalOnRecord,
  };

  if (!query.includeFees || rows.length === 0) {
    return {
      items: rows.map((row) => ({
        ...residentDto(row, context),
        currentMonth: emptyMonthStatus(month),
        overdue: EMPTY_OVERDUE,
      })),
      meta,
    };
  }

  // One roster+ledger load for the whole page. Archived residents are included
  // because the page may be showing exactly them, and their payments still count.
  const { index } = await loadRosterWithLedger(context, {
    residentIds: rows.map((row) => row.id),
    includeArchived: true,
    range: 'history',
    month,
  });

  const items = rows.map((row) => ({
    ...residentDto(row, context),
    currentMonth: toMonthFeeStatusDto(monthPosition(row, month, index, context)),
    // Arrears are always measured against today, never against a month the user
    // happens to be browsing: a future month cannot be late.
    overdue: toOverdueSummaryDto(residentArrears(row, index, context)),
  }));

  return { items, meta };
}

/* ------------------------------------------------------------------ *
 * Single resident
 * ------------------------------------------------------------------ */

export async function getResident(id: string): Promise<ResidentDto> {
  const { context } = await getFeeContext();
  const resident = await getResidentOr404(id);
  return residentDto(resident, context);
}

/* ------------------------------------------------------------------ *
 * Profile
 * ------------------------------------------------------------------ */

export async function getResidentProfile(
  id: string,
  query: ResidentProfileQuery,
): Promise<ResidentProfileDto> {
  const { context } = await getFeeContext();
  const resident = await getResidentOr404(id);
  const month = query.month ?? context.currentMonth;

  const [{ index }, totals, payments, moves] = await Promise.all([
    loadRosterWithLedger(context, {
      residentIds: [id],
      includeArchived: true,
      range: 'history',
      month,
    }),
    aggregateResidentPayments(id),
    listAllResidentPayments(id),
    listResidentMoves(id),
  ]);

  const feeResident: FeeResident = resident;
  const arrears = residentArrears(feeResident, index, context);

  // Look ahead if the caller is browsing a future month, so the history table
  // still contains the month they are looking at.
  const upToMonth = month > context.currentMonth ? month : context.currentMonth;
  const monthlyHistory = billableMonths(feeResident, context, upToMonth)
    .map((billingMonth) =>
      toMonthFeeStatusDto(monthPosition(feeResident, billingMonth, index, context)),
    )
    .reverse();

  return {
    resident: residentDto(resident, context),
    totals: {
      totalPaid: paiseToRupees(totals.total),
      paymentCount: totals.count,
      currentMonth: toMonthFeeStatusDto(monthPosition(feeResident, month, index, context)),
      overdue: toOverdueSummaryDto(arrears),
      outstandingAllMonths: paiseToRupees(arrears.outstandingAllMonths),
    },
    monthlyHistory,
    payments: payments.map(toFeePaymentDto),
    moves: moves.map(toResidentMoveDto),
  };
}

/* ------------------------------------------------------------------ *
 * Payments for one resident
 * ------------------------------------------------------------------ */

export async function listResidentPayments(
  id: string,
  query: ResidentPaymentListQuery,
): Promise<{ items: FeePaymentDto[]; meta: PaginationMeta }> {
  await getResidentOr404(id);

  const { rows, total } = await findResidentPaymentPage(
    residentPaymentWhere({
      residentId: id,
      month: query.month,
      buildingId: query.buildingId,
      from: query.from,
      to: query.to,
    }),
    paymentOrderBy(query.sortBy, query.sortOrder),
    query.page,
    query.pageSize,
  );

  return {
    items: rows.map(toFeePaymentDto),
    meta: buildPaginationMeta(query.page, query.pageSize, total),
  };
}

/* ------------------------------------------------------------------ *
 * Fee status strips
 * ------------------------------------------------------------------ */

/** One resident's Jan-Dec strip for a calendar year. */
export async function getResidentFeeStatus(
  id: string,
  query: FeeStatusQuery,
): Promise<FeeStatusStripDto> {
  const { context } = await getFeeContext();

  const { residents, index } = await loadRosterWithLedger(context, {
    residentIds: [id],
    includeArchived: true,
    range: 'year',
    year: query.year,
  });

  const resident = residents[0];
  if (!resident) throw residentNotFound();

  return {
    residentId: resident.id,
    year: query.year,
    months: yearStrip(resident, query.year, index, context),
  };
}

/**
 * Strips for many residents in one request - the call that stops the dashboard
 * issuing one request per resident. Exactly two queries, whatever `limit` is.
 */
export async function getFeeStatusBatch(query: FeeStatusBatchQuery): Promise<FeeStatusStripDto[]> {
  const { context } = await getFeeContext();

  const { residents, index } = await loadYearStripRoster({
    year: query.year,
    buildingId: query.buildingId,
    residentIds: query.residentIds,
    limit: query.limit,
    // Naming ids explicitly is an instruction to return exactly those people,
    // archived or not; browsing a building means the people still on the books.
    includeArchived: Boolean(query.residentIds),
  });

  return residents.map((resident) => ({
    residentId: resident.id,
    year: query.year,
    months: yearStrip(asStripFeeResident(resident), query.year, index, context),
  }));
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

export async function createResident(
  input: CreateResidentInput,
  auth: AuthContext,
): Promise<ResidentDto> {
  const { context } = await getFeeContext();

  const building = await findBuildingById(input.buildingId);
  if (!building) throw buildingNotFound();

  assertVacatedAfterJoin(input.joinMonth, input.vacatedMonth ?? null);

  const joinDate = joinDateFromMonth(input.joinMonth);
  const vacatedDate = input.vacatedMonth ? vacatedDateFromMonth(input.vacatedMonth) : null;

  return runInTransaction(async (tx) => {
    const created = await createResidentRow(
      {
        name: input.name,
        phone: input.phone ?? null,
        email: input.email ?? null,
        buildingId: input.buildingId,
        monthlyFee: rupeesToPaise(input.monthlyFee),
        dueDay: input.dueDay,
        joinDate,
        vacatedDate,
        notes: input.notes ?? null,
      },
      tx,
    );

    // The opening entry of the transfer history: nowhere -> their first building.
    await createMoveRow(
      {
        residentId: created.id,
        fromBuildingId: null,
        toBuildingId: created.buildingId,
        effectiveDate: joinDate,
        notes: null,
      },
      tx,
    );

    const dto = residentDto(created, context);
    await recordAudit(tx, {
      auth,
      action: 'CREATE',
      entityType: 'RESIDENT',
      entityId: created.id,
      summary: `Added ${created.name} to ${building.name}`,
      newData: dto,
    });

    return dto;
  });
}

/* ------------------------------------------------------------------ *
 * Update
 * ------------------------------------------------------------------ */

export async function updateResident(
  id: string,
  input: UpdateResidentInput,
  auth: AuthContext,
): Promise<ResidentDto> {
  const { context } = await getFeeContext();
  const existing = await getResidentOr404(id);
  const before = residentDto(existing, context);

  // Flipping `active` is archive/restore, which the role matrix reserves for an
  // owner even though the rest of an edit is an admin action.
  if (input.active !== undefined && input.active !== existing.active) {
    requireRole(auth, 'OWNER');
  }

  const movingBuilding =
    input.buildingId !== undefined && input.buildingId !== existing.buildingId;

  let targetBuilding: { id: string; name: string } | null = null;
  if (movingBuilding && input.buildingId) {
    targetBuilding = await findBuildingById(input.buildingId);
    if (!targetBuilding) throw buildingNotFound();
  }

  const joinMonth = input.joinMonth ?? utcDateToMonthKey(existing.joinDate);
  const vacatedMonth =
    input.vacatedMonth !== undefined
      ? input.vacatedMonth
      : existing.vacatedDate
        ? utcDateToMonthKey(existing.vacatedDate)
        : null;
  assertVacatedAfterJoin(joinMonth, vacatedMonth ?? null);

  const data: UpdateResidentData = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.phone !== undefined ? { phone: input.phone ?? null } : {}),
    ...(input.email !== undefined ? { email: input.email ?? null } : {}),
    ...(input.buildingId !== undefined ? { buildingId: input.buildingId } : {}),
    ...(input.monthlyFee !== undefined ? { monthlyFee: rupeesToPaise(input.monthlyFee) } : {}),
    ...(input.dueDay !== undefined ? { dueDay: input.dueDay } : {}),
    ...(input.joinMonth !== undefined ? { joinDate: joinDateFromMonth(input.joinMonth) } : {}),
    ...(input.vacatedMonth !== undefined
      ? { vacatedDate: input.vacatedMonth ? vacatedDateFromMonth(input.vacatedMonth) : null }
      : {}),
    ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
    ...(input.active !== undefined
      ? { active: input.active, archivedAt: input.active ? null : new Date() }
      : {}),
  };

  return runInTransaction(async (tx) => {
    const updated = await updateResidentRow(id, data, tx);

    // A building change made through the edit form is still a transfer and must
    // appear in the history the profile page renders.
    if (movingBuilding) {
      await createMoveRow(
        {
          residentId: id,
          fromBuildingId: existing.buildingId,
          toBuildingId: updated.buildingId,
          effectiveDate: isoDateToUtcDate(context.today),
          notes: 'Building changed while editing the resident',
        },
        tx,
      );
    }

    const after = residentDto(updated, context);
    await recordAudit(tx, {
      auth,
      action: 'UPDATE',
      entityType: 'RESIDENT',
      entityId: id,
      summary: movingBuilding
        ? `Updated ${updated.name}; moved to ${targetBuilding?.name ?? 'another building'}`
        : `Updated ${updated.name}`,
      oldData: before,
      newData: after,
    });

    return after;
  });
}

/* ------------------------------------------------------------------ *
 * Archive / delete
 * ------------------------------------------------------------------ */

/**
 * Remove a resident from the roster.
 *
 * A resident who has ever paid is archived, never deleted: the payments are the
 * hostel's books and must stay attached to a real person. Only somebody with no
 * financial history at all - a mistyped entry, usually - is physically removed.
 *
 * The payment count is read INSIDE the transaction that does the removal. On
 * PostgreSQL a stray payment would still have been caught by the foreign key;
 * MongoDB has none, so this count is the only thing that decides between a safe
 * archive and a delete that would orphan a row in the ledger.
 */
export async function deleteResident(
  id: string,
  auth: AuthContext,
): Promise<ResidentDeletionResult> {
  const { context } = await getFeeContext();

  return runInTransaction(async (tx) => {
    const existing = await getResidentOr404(id, tx);
    const snapshot = residentDto(existing, context);
    const paymentCount = await countResidentPayments(id, tx);

    if (paymentCount > 0) {
      const archived = await updateResidentRow(
        id,
        { active: false, archivedAt: new Date() },
        tx,
      );
      const dto = residentDto(archived, context);
      await recordAudit(tx, {
        auth,
        action: 'ARCHIVE',
        entityType: 'RESIDENT',
        entityId: id,
        summary: `Archived ${existing.name}; ${paymentCount} payment(s) retained`,
        oldData: snapshot,
        newData: dto,
      });
      return { archived: true, resident: dto };
    }

    await hardDeleteResident(id, tx);
    await recordAudit(tx, {
      auth,
      action: 'DELETE',
      entityType: 'RESIDENT',
      entityId: id,
      summary: `Deleted ${existing.name}; no payments were on record`,
      oldData: snapshot,
    });
    return { archived: false, resident: snapshot };
  });
}

/* ------------------------------------------------------------------ *
 * Move between buildings
 * ------------------------------------------------------------------ */

export async function moveResident(
  id: string,
  input: MoveResidentInput,
  auth: AuthContext,
): Promise<ResidentMoveResult> {
  const { context } = await getFeeContext();

  return runInTransaction(async (tx) => {
    // Re-read inside the transaction so two simultaneous moves cannot both
    // believe they are transferring from the same building.
    const existing = await getResidentOr404(id, tx);

    if (existing.buildingId === input.toBuildingId) {
      throw new ConflictError('Already in that building.');
    }

    const target = await findBuildingById(input.toBuildingId, tx);
    if (!target) throw buildingNotFound();

    const effectiveDate = isoDateToUtcDate(input.effectiveDate ?? context.today);

    const move = await createMoveRow(
      {
        residentId: id,
        fromBuildingId: existing.buildingId,
        toBuildingId: target.id,
        effectiveDate,
        notes: input.notes ?? null,
      },
      tx,
    );

    const updated = await updateResidentRow(id, { buildingId: target.id }, tx);
    const dto = residentDto(updated, context);

    await recordAudit(tx, {
      auth,
      action: 'MOVE',
      entityType: 'RESIDENT',
      entityId: id,
      summary: `Moved ${existing.name} from ${existing.building.name} to ${target.name}`,
      oldData: { buildingId: existing.buildingId, buildingName: existing.building.name },
      newData: { buildingId: target.id, buildingName: target.name },
    });

    return { resident: dto, move: toResidentMoveDto(move) };
  });
}

/* ------------------------------------------------------------------ *
 * Vacate
 * ------------------------------------------------------------------ */

/**
 * Record that a resident is leaving. The vacating month is billed in full, so
 * the stored date is its last day and the fee engine keeps charging until then.
 */
export async function vacateResident(
  id: string,
  input: VacateResidentInput,
  auth: AuthContext,
): Promise<ResidentDto> {
  const { context } = await getFeeContext();
  const existing = await getResidentOr404(id);
  const before = residentDto(existing, context);

  assertVacatedAfterJoin(utcDateToMonthKey(existing.joinDate), input.vacatedMonth);

  const vacatedDate = vacatedDateFromMonth(input.vacatedMonth);

  return runInTransaction(async (tx) => {
    const updated = await updateResidentRow(id, { vacatedDate }, tx);
    const after = residentDto(updated, context);

    await recordAudit(tx, {
      auth,
      action: 'UPDATE',
      entityType: 'RESIDENT',
      entityId: id,
      // The note is context for the trail; it never overwrites the resident's
      // own notes field, which is a different piece of information.
      summary: input.notes
        ? `${updated.name} vacating at the end of ${input.vacatedMonth}: ${input.notes}`
        : `${updated.name} vacating at the end of ${input.vacatedMonth}`,
      oldData: before,
      newData: after,
    });

    return after;
  });
}

export type { ResidentRecord };
