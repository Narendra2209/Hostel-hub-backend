/**
 * Resident persistence.
 *
 * Every query the resident surface needs lives here: the list page (paginated by
 * MongoDB, never in memory), the counters the list header shows, the profile's
 * satellite collections, and the two-query loader that powers the batch fee
 * strips.
 *
 * No financial rule is implemented in this file. Balances, statuses and arrears
 * are always derived by `lib/services/fee-engine.ts` from rows loaded here.
 * `monthlyFee` and every payment amount below are integer PAISE.
 */
import type { Prisma } from '@prisma/client';
import type { MonthKey, ResidentStatusFilter } from '@hostel/shared';
import { monthKeyToUtcDate } from '@hostel/shared';
import { prisma, type PrismaLike } from '../db/prisma';
import { ROSTER_SELECT } from '../services/roster.service';
import { residentInclude } from '../services/mappers';
import { buildPaymentIndex, type FeeResident, type PaymentIndex } from '../services/fee-engine';
import {
  dateRange,
  isAllBuildings,
  monthDateRange,
  monthSpanRange,
  residentBuildingWhere,
  searchFilter,
  type BuildingFilter,
} from './filters';

/* ------------------------------------------------------------------ *
 * Row shapes
 * ------------------------------------------------------------------ */

/**
 * The roster columns plus `archivedAt`, which makes the row structurally a full
 * `Resident` and therefore usable with `toResidentDto` as well as the fee engine.
 */
export const RESIDENT_ROW_SELECT = {
  ...ROSTER_SELECT,
  archivedAt: true,
} satisfies Prisma.ResidentSelect;

export type ResidentRow = Prisma.ResidentGetPayload<{ select: typeof RESIDENT_ROW_SELECT }>;

/** A resident loaded with its building - what every single-record route returns. */
export type ResidentRecord = Prisma.ResidentGetPayload<{ include: typeof residentInclude }>;

/** The minimum the fee engine needs to draw a Jan-Dec strip. */
export const FEE_STRIP_SELECT = {
  id: true,
  monthlyFee: true,
  dueDay: true,
  joinDate: true,
  vacatedDate: true,
} satisfies Prisma.ResidentSelect;

export type FeeStripResident = Prisma.ResidentGetPayload<{ select: typeof FEE_STRIP_SELECT }>;

export const moveInclude = {
  fromBuilding: { select: { id: true, name: true } },
  toBuilding: { select: { id: true, name: true } },
} as const;

export type MoveRow = Prisma.ResidentBuildingHistoryGetPayload<{ include: typeof moveInclude }>;

/**
 * Declared here (rather than imported as a value from `mappers`) so Prisma can
 * infer the payload type of the payment queries below. It is the same shape as
 * `mappers.paymentInclude`, which is what `toFeePaymentDto` expects.
 */
export const residentPaymentInclude = {
  resident: {
    select: {
      id: true,
      name: true,
      buildingId: true,
      building: { select: { id: true, name: true } },
    },
  },
  createdBy: { select: { name: true } },
} as const;

export type PaymentRow = Prisma.FeePaymentGetPayload<{ include: typeof residentPaymentInclude }>;

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

/**
 * The four resident status slices.
 *
 * `vacatedDate` is stored as the LAST day of the vacating month, so
 * "vacated month >= current month" is exactly "vacatedDate >= first day of the
 * current month" - an index-friendly range predicate rather than a computed one.
 */
export function residentStatusWhere(
  status: ResidentStatusFilter,
  currentMonth: MonthKey,
): Prisma.ResidentWhereInput {
  const startOfCurrentMonth = monthKeyToUtcDate(currentMonth);
  switch (status) {
    case 'staying':
      return {
        active: true,
        OR: [{ vacatedDate: null }, { vacatedDate: { gte: startOfCurrentMonth } }],
      };
    case 'vacated':
      // MongoDB's range operators are type-bracketed: a null `vacatedDate` can
      // never satisfy `< <a date>`, so residents who are still staying are
      // excluded by the query itself rather than by a second pass in memory.
      return { active: true, vacatedDate: { lt: startOfCurrentMonth } };
    case 'archived':
      return { active: false };
    case 'all':
    default:
      return {};
  }
}

/** Name or phone, case-insensitive. */
export function residentSearchWhere(search?: string): Prisma.ResidentWhereInput | undefined {
  const filter = searchFilter(search);
  if (!filter) return undefined;
  return { OR: [{ name: filter }, { phone: filter }] };
}

export interface ResidentScope {
  buildingId: BuildingFilter;
  search?: string;
}

/**
 * The population a list request is looking at, ignoring the status slice.
 * Both header counters (`stayingCount`, `totalOnRecord`) are measured against it
 * so they describe the same set of people the table is paging through.
 */
export function residentScopeWhere(scope: ResidentScope): Prisma.ResidentWhereInput {
  const clauses: Prisma.ResidentWhereInput[] = [residentBuildingWhere(scope.buildingId)];
  const search = residentSearchWhere(scope.search);
  if (search) clauses.push(search);
  return { AND: clauses };
}

export function residentListWhere(
  scope: ResidentScope,
  status: ResidentStatusFilter,
  currentMonth: MonthKey,
): Prisma.ResidentWhereInput {
  return { AND: [residentScopeWhere(scope), residentStatusWhere(status, currentMonth)] };
}

export type ResidentSortBy = 'name' | 'monthlyFee' | 'joinDate' | 'dueDay' | 'building';

export function residentOrderBy(
  sortBy: ResidentSortBy,
  sortOrder: 'asc' | 'desc',
): Prisma.ResidentOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'monthlyFee':
      return [{ monthlyFee: sortOrder }, { name: 'asc' }];
    case 'joinDate':
      return [{ joinDate: sortOrder }, { name: 'asc' }];
    case 'dueDay':
      return [{ dueDay: sortOrder }, { name: 'asc' }];
    case 'building':
      return [{ building: { name: sortOrder } }, { name: 'asc' }];
    case 'name':
    default:
      return [{ name: sortOrder }];
  }
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export function findResidentById(
  id: string,
  client: PrismaLike = prisma,
): Promise<ResidentRecord | null> {
  return client.resident.findUnique({ where: { id }, include: residentInclude });
}

export function countResidents(
  where: Prisma.ResidentWhereInput,
  client: PrismaLike = prisma,
): Promise<number> {
  return client.resident.count({ where });
}

export function findResidentPage(
  where: Prisma.ResidentWhereInput,
  orderBy: Prisma.ResidentOrderByWithRelationInput[],
  page: number,
  pageSize: number,
  client: PrismaLike = prisma,
): Promise<ResidentRow[]> {
  return client.resident.findMany({
    where,
    select: RESIDENT_ROW_SELECT,
    orderBy,
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
}

export function findBuildingById(
  id: string,
  client: PrismaLike = prisma,
): Promise<{ id: string; name: string } | null> {
  return client.building.findUnique({ where: { id }, select: { id: true, name: true } });
}

export function listResidentMoves(
  residentId: string,
  client: PrismaLike = prisma,
): Promise<MoveRow[]> {
  return client.residentBuildingHistory.findMany({
    where: { residentId },
    include: moveInclude,
    orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
  });
}

/** Every payment ever recorded for one resident, newest first. */
export function listAllResidentPayments(
  residentId: string,
  client: PrismaLike = prisma,
): Promise<PaymentRow[]> {
  return client.feePayment.findMany({
    where: { residentId },
    include: residentPaymentInclude,
    orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
  });
}

/** Lifetime money-in for one resident, as one aggregate - never a per-month loop. */
export async function aggregateResidentPayments(
  residentId: string,
  client: PrismaLike = prisma,
): Promise<{ total: number | null; count: number }> {
  const result = await client.feePayment.aggregate({
    where: { residentId },
    _sum: { amount: true },
    _count: { _all: true },
  });
  return { total: result._sum.amount, count: result._count._all };
}

export function countResidentPayments(
  residentId: string,
  client: PrismaLike = prisma,
): Promise<number> {
  return client.feePayment.count({ where: { residentId } });
}

/* ------------------------------------------------------------------ *
 * Payment list for one resident
 * ------------------------------------------------------------------ */

export interface ResidentPaymentFilters {
  residentId: string;
  month?: MonthKey;
  buildingId: BuildingFilter;
  from?: string;
  to?: string;
}

export function residentPaymentWhere(filters: ResidentPaymentFilters): Prisma.FeePaymentWhereInput {
  const paymentDate = dateRange(filters.from, filters.to);
  return {
    residentId: filters.residentId,
    ...(filters.month ? { billingMonth: monthDateRange(filters.month) } : {}),
    ...(paymentDate ? { paymentDate } : {}),
    // A resident belongs to exactly one building, so a mismatched building filter
    // narrows the result to nothing - the honest answer rather than a silent
    // "filter ignored".
    ...(isAllBuildings(filters.buildingId)
      ? {}
      : { resident: residentBuildingWhere(filters.buildingId) }),
  };
}

export type PaymentSortBy = 'paymentDate' | 'amount' | 'billingMonth' | 'createdAt';

export function paymentOrderBy(
  sortBy: PaymentSortBy,
  sortOrder: 'asc' | 'desc',
): Prisma.FeePaymentOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'amount':
      return [{ amount: sortOrder }, { paymentDate: 'desc' }];
    case 'billingMonth':
      return [{ billingMonth: sortOrder }, { paymentDate: 'desc' }];
    case 'createdAt':
      return [{ createdAt: sortOrder }];
    case 'paymentDate':
    default:
      return [{ paymentDate: sortOrder }, { createdAt: sortOrder }];
  }
}

export async function findResidentPaymentPage(
  where: Prisma.FeePaymentWhereInput,
  orderBy: Prisma.FeePaymentOrderByWithRelationInput[],
  page: number,
  pageSize: number,
  client: PrismaLike = prisma,
): Promise<{ rows: PaymentRow[]; total: number }> {
  const [total, rows] = await Promise.all([
    client.feePayment.count({ where }),
    client.feePayment.findMany({
      where,
      include: residentPaymentInclude,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return { rows, total };
}

/* ------------------------------------------------------------------ *
 * Batch fee strips: exactly two queries, whatever the resident count
 * ------------------------------------------------------------------ */

export interface YearStripRosterOptions {
  year: number;
  buildingId: BuildingFilter;
  residentIds?: string[];
  limit: number;
  /** Archived residents are excluded unless the caller named ids explicitly. */
  includeArchived: boolean;
}

/**
 * Residents for a batch strip request, plus the payment index for that calendar
 * year. `limit` is applied by MongoDB, so the payments query is bounded by the
 * page the caller actually asked for - one roster query, one payments query.
 */
export async function loadYearStripRoster(
  options: YearStripRosterOptions,
  client: PrismaLike = prisma,
): Promise<{ residents: FeeStripResident[]; index: PaymentIndex }> {
  const where: Prisma.ResidentWhereInput = {
    ...(options.includeArchived ? {} : { active: true }),
    ...residentBuildingWhere(options.buildingId),
    ...(options.residentIds ? { id: { in: options.residentIds } } : {}),
  };

  const residents = await client.resident.findMany({
    where,
    select: FEE_STRIP_SELECT,
    orderBy: [{ name: 'asc' }],
    take: options.limit,
  });

  if (residents.length === 0) return { residents, index: new Map() };

  const payments = await client.feePayment.findMany({
    where: {
      residentId: { in: residents.map((resident) => resident.id) },
      billingMonth: monthSpanRange(`${options.year}-01`, `${options.year}-12`),
    },
    select: { residentId: true, billingMonth: true, amount: true },
  });

  return { residents, index: buildPaymentIndex(payments) };
}

/** The strip rows satisfy the engine's contract without any adaptation. */
export const asStripFeeResident = (resident: FeeStripResident): FeeResident => resident;

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

export interface CreateResidentData {
  name: string;
  phone: string | null;
  email: string | null;
  buildingId: string;
  /** Paise, already converted from the validated rupee input. */
  monthlyFee: number;
  dueDay: number;
  joinDate: Date;
  vacatedDate: Date | null;
  notes: string | null;
}

/** Only the columns a PATCH actually touched are present. */
export type UpdateResidentData = Partial<CreateResidentData> & {
  active?: boolean;
  archivedAt?: Date | null;
};

export function createResidentRow(
  data: CreateResidentData,
  client: PrismaLike,
): Promise<ResidentRecord> {
  return client.resident.create({ data, include: residentInclude });
}

/**
 * A PATCH carries only the fields it touched, and for several of them null is a
 * real value rather than "leave it alone": clearing `vacatedDate` un-vacates a
 * resident, clearing `archivedAt` restores one, and `phone`, `email` and `notes`
 * are all legitimately erasable. Prisma reads `undefined` as "not provided" and
 * `null` as "write null", which is exactly that distinction, so the partial goes
 * straight through.
 *
 * Because `buildingId` is the raw scalar rather than the `building` relation,
 * this only satisfies Prisma's *unchecked* update input; moving a resident is
 * still a service-level operation that writes a history row alongside this.
 */
export function updateResidentRow(
  id: string,
  data: UpdateResidentData,
  client: PrismaLike,
): Promise<ResidentRecord> {
  return client.resident.update({ where: { id }, data, include: residentInclude });
}


export interface MoveWriteData {
  residentId: string;
  fromBuildingId: string | null;
  toBuildingId: string;
  effectiveDate: Date;
  notes: string | null;
}

export function createMoveRow(data: MoveWriteData, client: PrismaLike): Promise<MoveRow> {
  return client.residentBuildingHistory.create({ data, include: moveInclude });
}

/**
 * Physically remove a resident. Only ever called after the service has proved
 * there is no financial history; the building-history rows go with it because
 * they describe a person who never transacted.
 *
 * MongoDB has no ON DELETE CASCADE, so the history rows are deleted explicitly
 * here and the "has this person ever transacted?" guard in the service layer is
 * now the only thing standing between a delete and orphaned ledger rows.
 */
export async function hardDeleteResident(id: string, client: PrismaLike): Promise<void> {
  await client.residentBuildingHistory.deleteMany({ where: { residentId: id } });
  await client.resident.delete({ where: { id } });
}
