/**
 * Expense data access.
 *
 * Every query the expense screens, the P&L and the CSV exports need is defined
 * here, and every one of them is a *set* operation: a page of rows, an
 * aggregate, a groupBy, or one range scan whose rows are folded in memory.
 * Nothing in this file may be called from inside a loop over buildings,
 * categories or months.
 *
 * All amounts are integer PAISE, in and out - that is how the column is stored
 * (Prisma's MongoDB connector has no decimal type) and how every aggregate below
 * comes back. The single conversion to the rupee number a DTO carries happens in
 * the mapper, not here.
 */
import type { Prisma } from '@prisma/client';
import type { MonthKey } from '@hostel/shared';
import { prisma, type PrismaLike } from '../db/prisma';
import { expenseInclude, type ExpenseWithRelations } from '../services/mappers';
import {
  dateRange,
  escapeRegExp,
  monthDateRange,
  nullableBuildingWhere,
  type BuildingFilter,
} from './filters';

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

export interface ExpenseFilters {
  /** Restrict to one month, matched against the expense date. */
  month?: MonthKey;
  /** 'all' | 'shared' | a building's ObjectId. */
  buildingId?: BuildingFilter;
  categoryId?: string;
  /** Inclusive calendar-date bounds, applied on top of `month`. */
  from?: string;
  to?: string;
  /** Free text over vendor, reference, note and category name. */
  search?: string;
}

/**
 * Case-insensitive contains, typed so it fits nullable and non-null columns
 * alike. The term is escaped: Prisma's MongoDB connector treats `contains` as a
 * regular expression, so an unescaped bracket from a search box is a 500 and an
 * unescaped `(a+)+$` is a denial of service. See escapeRegExp in filters.ts.
 */
const containsText = (term: string): { contains: string; mode: 'insensitive' } => ({
  contains: escapeRegExp(term),
  mode: 'insensitive',
});

/**
 * Build the `where` clause once so the page query, the count and every
 * aggregate see exactly the same set of rows.
 */
export function expenseWhere(filters: ExpenseFilters): Prisma.ExpenseWhereInput {
  const dateClauses: Prisma.ExpenseWhereInput[] = [];
  if (filters.month) dateClauses.push({ date: monthDateRange(filters.month) });
  const explicitRange = dateRange(filters.from, filters.to);
  if (explicitRange) dateClauses.push({ date: explicitRange });

  const term = filters.search?.trim();

  return {
    ...(filters.buildingId ? nullableBuildingWhere(filters.buildingId) : {}),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(dateClauses.length ? { AND: dateClauses } : {}),
    ...(term
      ? {
          OR: [
            { vendor: containsText(term) },
            { referenceNumber: containsText(term) },
            { note: containsText(term) },
            { category: { name: containsText(term) } },
          ],
        }
      : {}),
  };
}

export type ExpenseSortBy = 'date' | 'amount' | 'category';

export function expenseOrderBy(
  sortBy: ExpenseSortBy,
  sortOrder: 'asc' | 'desc',
): Prisma.ExpenseOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'amount':
      return [{ amount: sortOrder }, { date: 'desc' }, { createdAt: 'desc' }];
    case 'category':
      return [{ category: { name: sortOrder } }, { date: 'desc' }, { createdAt: 'desc' }];
    default:
      return [{ date: sortOrder }, { createdAt: sortOrder }];
  }
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export function findExpensePage(
  args: {
    where: Prisma.ExpenseWhereInput;
    orderBy: Prisma.ExpenseOrderByWithRelationInput[];
    skip: number;
    take: number;
  },
  client: PrismaLike = prisma,
): Promise<ExpenseWithRelations[]> {
  return client.expense.findMany({
    where: args.where,
    orderBy: args.orderBy,
    skip: args.skip,
    take: args.take,
    include: expenseInclude,
  });
}

export function findExpenseById(
  id: string,
  client: PrismaLike = prisma,
): Promise<ExpenseWithRelations | null> {
  return client.expense.findUnique({ where: { id }, include: expenseInclude });
}

/** Whole-set total and row count - never just the current page's slice. */
export async function aggregateExpenses(
  where: Prisma.ExpenseWhereInput,
  client: PrismaLike = prisma,
): Promise<{ total: number | null; count: number }> {
  const result = await client.expense.aggregate({
    where,
    _sum: { amount: true },
    _count: { _all: true },
  });
  return { total: result._sum.amount, count: result._count._all };
}

export async function groupExpensesByCategory(
  where: Prisma.ExpenseWhereInput,
  client: PrismaLike = prisma,
): Promise<{ categoryId: string; amount: number | null }[]> {
  const rows = await client.expense.groupBy({
    by: ['categoryId'],
    where,
    _sum: { amount: true },
  });
  return rows.map((row) => ({ categoryId: row.categoryId, amount: row._sum.amount }));
}

export async function groupExpensesByBuilding(
  where: Prisma.ExpenseWhereInput,
  client: PrismaLike = prisma,
): Promise<{ buildingId: string | null; amount: number | null }[]> {
  const rows = await client.expense.groupBy({
    by: ['buildingId'],
    where,
    _sum: { amount: true },
  });
  return rows.map((row) => ({ buildingId: row.buildingId, amount: row._sum.amount }));
}

/**
 * One range scan for the P&L: every expense in a date window carrying just the
 * columns the report folds over. A calendar year of a hostel's bills is a few
 * hundred rows, which is far cheaper than twelve grouped queries per building.
 */
export interface ExpenseRangeRow {
  date: Date;
  buildingId: string | null;
  /** Paise. */
  amount: number;
  category: { id: string; name: string; sortOrder: number };
}

export function findExpensesInRange(
  range: { gte: Date; lt: Date },
  buildingId: BuildingFilter,
  client: PrismaLike = prisma,
): Promise<ExpenseRangeRow[]> {
  return client.expense.findMany({
    where: { date: range, ...nullableBuildingWhere(buildingId) },
    select: {
      date: true,
      buildingId: true,
      amount: true,
      category: { select: { id: true, name: true, sortOrder: true } },
    },
  });
}

/** Rows for the expenses CSV/JSON export, capped so one request cannot exhaust memory. */
export function findExpensesForExport(
  where: Prisma.ExpenseWhereInput,
  take: number,
  client: PrismaLike = prisma,
): Promise<ExpenseWithRelations[]> {
  return client.expense.findMany({
    where,
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    take,
    include: expenseInclude,
  });
}

/* ------------------------------------------------------------------ *
 * Name lookups for grouped results
 * ------------------------------------------------------------------ */

export async function categoryNamesByIds(
  ids: string[],
  client: PrismaLike = prisma,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await client.expenseCategory.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name] as const));
}

export async function buildingNamesByIds(
  ids: string[],
  client: PrismaLike = prisma,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await client.building.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name] as const));
}

/* ------------------------------------------------------------------ *
 * Writes. Each takes the transaction client so the audit row commits with it.
 * ------------------------------------------------------------------ */

export interface ExpenseWriteData {
  date: Date;
  buildingId: string | null;
  categoryId: string;
  /** Paise, already converted from the validated rupee input. */
  amount: number;
  vendor: string | null;
  referenceNumber: string | null;
  note: string | null;
  createdById: string | null;
}

export function insertExpense(
  client: PrismaLike,
  data: ExpenseWriteData,
): Promise<ExpenseWithRelations> {
  return client.expense.create({ data, include: expenseInclude });
}

/**
 * A PATCH carries only the fields it touched. The distinction that matters is
 * absent vs null: an absent `buildingId` leaves the bill attributed where it
 * was, while an explicit `buildingId: null` re-files it as a shared cost. Prisma
 * reads `undefined` as "not provided" and `null` as "write null", which is
 * exactly that distinction, so the partial goes straight through.
 *
 * Because `buildingId` is the raw scalar rather than the `building` relation,
 * this only satisfies Prisma's *unchecked* update input - the checked one would
 * demand a nested relation write. That is fine, and it is also the reason the
 * caller must never be handed a plain `Prisma.ExpenseUpdateInput` here.
 */
export function updateExpenseRow(
  client: PrismaLike,
  id: string,
  data: Partial<Omit<ExpenseWriteData, 'createdById'>>,
): Promise<ExpenseWithRelations> {
  return client.expense.update({ where: { id }, data, include: expenseInclude });
}


export async function deleteExpenseRow(client: PrismaLike, id: string): Promise<void> {
  await client.expense.delete({ where: { id } });
}
