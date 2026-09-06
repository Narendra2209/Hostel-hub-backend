/**
 * Staff and salary-payment persistence.
 *
 * Two rules shape everything in this file:
 *
 *  * There is no `paid` field on a salary month. What a staff member has been
 *    paid for a month is always the sum of `salary_payments.amount` over that
 *    month, so partial payments and several payments in one month are normal.
 *  * A salary register renders one row per staff member, so the paid amounts for
 *    a whole page are fetched with a single `groupBy` keyed by staff id - never
 *    one aggregate per person.
 *
 * Salaries and payment amounts are integer PAISE.
 */
import type { Prisma } from '@prisma/client';
import type { MonthKey } from '@hostel/shared';
import { prisma, type PrismaLike } from '../db/prisma';
import { toPaise, type Paise } from '../db/money';
import {
  isAllBuildings,
  monthDateRange,
  nullableBuildingWhere,
  searchFilter,
  type BuildingFilter,
} from './filters';
import { salaryInclude, type SalaryWithRelations, type StaffWithBuilding } from '../services/mappers';

/** Relations `toStaffDto` expects. */
export const staffInclude = {
  building: { select: { id: true, name: true } },
} satisfies Prisma.StaffInclude;

export type StaffStatusFilter = 'all' | 'active' | 'inactive';

export interface StaffWhereOptions {
  buildingId?: BuildingFilter;
  status?: StaffStatusFilter;
  search?: string;
}

/**
 * The staff list filter.
 * "shared" means the members that are not attached to a single building - the
 * ones the UI labels "All buildings".
 */
export function staffWhere(options: StaffWhereOptions = {}): Prisma.StaffWhereInput {
  const status = options.status ?? 'all';
  const search = searchFilter(options.search);
  return {
    ...(options.buildingId && !isAllBuildings(options.buildingId)
      ? nullableBuildingWhere(options.buildingId)
      : {}),
    ...(status === 'all' ? {} : { active: status === 'active' }),
    ...(search ? { OR: [{ name: search }, { role: search }, { phone: search }] } : {}),
  };
}

export type StaffSortField = 'name' | 'monthlySalary' | 'role';

export function staffOrderBy(
  sortBy: StaffSortField,
  sortOrder: 'asc' | 'desc',
): Prisma.StaffOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'monthlySalary':
      return [{ monthlySalary: sortOrder }, { name: 'asc' }];
    case 'role':
      return [{ role: sortOrder }, { name: 'asc' }];
    default:
      return [{ name: sortOrder }];
  }
}

/* ------------------------------------------------------------------ *
 * Staff reads
 * ------------------------------------------------------------------ */

/** One page of the register, with the building relation the mapper needs. */
export function findStaffPage(
  where: Prisma.StaffWhereInput,
  options: { orderBy: Prisma.StaffOrderByWithRelationInput[]; skip: number; take: number },
  client: PrismaLike = prisma,
): Promise<StaffWithBuilding[]> {
  return client.staff.findMany({
    where,
    include: staffInclude,
    orderBy: options.orderBy,
    skip: options.skip,
    take: options.take,
  });
}

export interface StaffScopeRow {
  id: string;
  active: boolean;
  /** Paise. */
  monthlySalary: number;
}

/**
 * Every staff member matching the filter, reduced to the three columns the
 * payroll totals need. One narrow indexed query covers both the pagination
 * total and the whole-filter totals, so paging never changes the stat cards.
 */
export function findStaffScope(
  where: Prisma.StaffWhereInput,
  client: PrismaLike = prisma,
): Promise<StaffScopeRow[]> {
  return client.staff.findMany({
    where,
    select: { id: true, active: true, monthlySalary: true },
  });
}

export function findStaffById(
  id: string,
  client: PrismaLike = prisma,
): Promise<StaffWithBuilding | null> {
  return client.staff.findUnique({ where: { id }, include: staffInclude });
}

export function countSalaryPaymentsForStaff(
  staffId: string,
  client: PrismaLike = prisma,
): Promise<number> {
  return client.salaryPayment.count({ where: { staffId } });
}

/* ------------------------------------------------------------------ *
 * Staff writes
 * ------------------------------------------------------------------ */

export function createStaffRow(
  data: Prisma.StaffUncheckedCreateInput,
  client: PrismaLike = prisma,
): Promise<StaffWithBuilding> {
  return client.staff.create({ data, include: staffInclude });
}

export function updateStaffRow(
  id: string,
  data: Prisma.StaffUncheckedUpdateInput,
  client: PrismaLike = prisma,
): Promise<StaffWithBuilding> {
  return client.staff.update({ where: { id }, data, include: staffInclude });
}

export async function deleteStaffRow(id: string, client: PrismaLike = prisma): Promise<void> {
  await client.staff.delete({ where: { id } });
}

/* ------------------------------------------------------------------ *
 * Salary payments
 * ------------------------------------------------------------------ */

export interface SalaryPaidEntry {
  /** Paise. */
  paid: Paise;
  count: number;
}

/**
 * staffId -> { paid, count } for one salary month, in ONE query.
 * This is what keeps the register free of a per-staff aggregate.
 */
export async function salaryPaidByStaff(
  staffIds: string[],
  month: MonthKey,
  client: PrismaLike = prisma,
): Promise<Map<string, SalaryPaidEntry>> {
  const index = new Map<string, SalaryPaidEntry>();
  if (staffIds.length === 0) return index;

  const rows = await client.salaryPayment.groupBy({
    by: ['staffId'],
    where: { staffId: { in: staffIds }, salaryMonth: monthDateRange(month) },
    _sum: { amount: true },
    _count: { _all: true },
  });

  for (const row of rows) {
    index.set(row.staffId, { paid: toPaise(row._sum.amount), count: row._count._all });
  }
  return index;
}

/**
 * Serialise concurrent settlements for one staff member.
 *
 * "Settle" reads what has already been paid and then inserts the remainder, so
 * two managers pressing "Full" at the same instant must not both read the same
 * total and pay the balance twice.
 *
 * PostgreSQL expressed that as `SELECT ... FOR UPDATE`. MongoDB has no such
 * statement, and a read inside a transaction takes no lock at all - it sees a
 * snapshot taken when the transaction started, so reading the staff document
 * would provide no protection whatsoever. The only way two MongoDB transactions
 * contend is by both WRITING the same document, so this touches the staff
 * document itself: the first transaction to arrive holds that document's write
 * lock until it commits, and a second one that tries to settle the same person
 * meanwhile is aborted with a write conflict.
 *
 * The guarantee is the same - the balance can only be paid once - but the losing
 * caller is rejected rather than queued behind the winner, so it surfaces as a
 * failed request the manager retries, and the retry then correctly sees the
 * salary as already settled.
 */
export async function lockStaffRow(staffId: string, client: PrismaLike): Promise<void> {
  await client.staff.update({ where: { id: staffId }, data: { updatedAt: new Date() } });
}

/**
 * What one staff member has already been paid for one month, in paise.
 * `_sum` over an Int field is `number | null`; `toPaise` turns the "no payments
 * at all" null into an exact zero.
 */
export async function sumSalaryPaid(
  staffId: string,
  month: MonthKey,
  client: PrismaLike = prisma,
): Promise<Paise> {
  const aggregate = await client.salaryPayment.aggregate({
    where: { staffId, salaryMonth: monthDateRange(month) },
    _sum: { amount: true },
  });
  return toPaise(aggregate._sum.amount);
}

export interface SalaryWhereOptions {
  month?: MonthKey;
  buildingId?: BuildingFilter;
  staffId?: string;
  search?: string;
}

export function salaryPaymentWhere(
  options: SalaryWhereOptions = {},
): Prisma.SalaryPaymentWhereInput {
  const search = searchFilter(options.search);
  const buildingScope =
    options.buildingId && !isAllBuildings(options.buildingId)
      ? nullableBuildingWhere(options.buildingId)
      : {};

  return {
    ...(options.month ? { salaryMonth: monthDateRange(options.month) } : {}),
    ...(options.staffId ? { staffId: options.staffId } : {}),
    ...(Object.keys(buildingScope).length > 0 ? { staff: buildingScope } : {}),
    ...(search ? { OR: [{ staff: { name: search } }, { note: search }] } : {}),
  };
}

export type SalarySortField = 'paymentDate' | 'amount' | 'salaryMonth';

export function salaryPaymentOrderBy(
  sortBy: SalarySortField,
  sortOrder: 'asc' | 'desc',
): Prisma.SalaryPaymentOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'amount':
      return [{ amount: sortOrder }, { paymentDate: 'desc' }];
    case 'salaryMonth':
      return [{ salaryMonth: sortOrder }, { paymentDate: 'desc' }];
    default:
      return [{ paymentDate: sortOrder }, { createdAt: sortOrder }];
  }
}

export function countSalaryPayments(
  where: Prisma.SalaryPaymentWhereInput,
  client: PrismaLike = prisma,
): Promise<number> {
  return client.salaryPayment.count({ where });
}

export function findSalaryPaymentPage(
  where: Prisma.SalaryPaymentWhereInput,
  options: {
    orderBy: Prisma.SalaryPaymentOrderByWithRelationInput[];
    skip: number;
    take: number;
  },
  client: PrismaLike = prisma,
): Promise<SalaryWithRelations[]> {
  return client.salaryPayment.findMany({
    where,
    include: salaryInclude,
    orderBy: options.orderBy,
    skip: options.skip,
    take: options.take,
  });
}

export function findSalaryPaymentById(
  id: string,
  client: PrismaLike = prisma,
): Promise<SalaryWithRelations | null> {
  return client.salaryPayment.findUnique({ where: { id }, include: salaryInclude });
}

export function createSalaryPaymentRow(
  data: Prisma.SalaryPaymentUncheckedCreateInput,
  client: PrismaLike = prisma,
): Promise<SalaryWithRelations> {
  return client.salaryPayment.create({ data, include: salaryInclude });
}

export function updateSalaryPaymentRow(
  id: string,
  data: Prisma.SalaryPaymentUncheckedUpdateInput,
  client: PrismaLike = prisma,
): Promise<SalaryWithRelations> {
  return client.salaryPayment.update({ where: { id }, data, include: salaryInclude });
}

export async function deleteSalaryPaymentRow(
  id: string,
  client: PrismaLike = prisma,
): Promise<void> {
  await client.salaryPayment.delete({ where: { id } });
}
