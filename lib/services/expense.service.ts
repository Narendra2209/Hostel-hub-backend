/**
 * Running costs ("bills").
 *
 * An expense is the leaf of the financial graph: nothing references it, so
 * unlike a resident or a staff member it can genuinely be removed rather than
 * archived. Every write still happens inside a transaction that also writes the
 * audit row, so a deleted bill leaves a permanent trace of who removed it and
 * what it contained.
 *
 * The list totals deliberately describe the *whole filtered set*, not the page
 * on screen: they come from one aggregate plus two groupBy queries, so paging
 * through 500 bills never changes the headline number and never costs more
 * queries.
 */
import type {
  CreateExpenseInput,
  ExpenseDto,
  ExpenseTotalsDto,
  UpdateExpenseInput,
} from '@hostel/shared';
import { isoDateToUtcDate, SHARED_BUILDING } from '@hostel/shared';
import type { z } from 'zod';
import type { expenseListQuerySchema } from '@hostel/shared';
import { prisma } from '../db/prisma';
import { paiseToRupees, rupeesToPaise } from '../db/money';
import { buildingNotFound, categoryNotFound, expenseNotFound } from '../errors/app-error';
import type { AuthContext } from '../auth/context';
import { recordAudit } from './audit.service';
import { ensureDefaultCategories } from './settings.service';
import { toExpenseDto, type ExpenseWithRelations } from './mappers';
import {
  aggregateExpenses,
  categoryNamesByIds,
  buildingNamesByIds,
  deleteExpenseRow,
  expenseOrderBy,
  expenseWhere,
  findExpenseById,
  findExpensePage,
  groupExpensesByBuilding,
  groupExpensesByCategory,
  insertExpense,
  updateExpenseRow,
  type ExpenseWriteData,
} from '../repositories/expense.repository';

export type ExpenseListQuery = z.infer<typeof expenseListQuerySchema>;

/** The label the UI shows for costs that were never attributed to a building. */
export const SHARED_LABEL = 'Shared';

/** True when the key was sent at all - `null` clears a field, absent leaves it. */
const provided = (input: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(input, key);

/* ------------------------------------------------------------------ *
 * Listing
 * ------------------------------------------------------------------ */

export interface ExpenseListResult {
  items: ExpenseDto[];
  total: number;
  totals: ExpenseTotalsDto;
}

export async function listExpenses(query: ExpenseListQuery): Promise<ExpenseListResult> {
  // Categories are configuration, bootstrapped on first touch, so an empty
  // database still offers the eight defaults to file a bill against.
  await ensureDefaultCategories();

  const where = expenseWhere({
    month: query.month,
    buildingId: query.buildingId,
    categoryId: query.categoryId,
    from: query.from,
    to: query.to,
    search: query.search,
  });

  const [rows, aggregate, categoryGroups, buildingGroups] = await Promise.all([
    findExpensePage({
      where,
      orderBy: expenseOrderBy(query.sortBy, query.sortOrder),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    aggregateExpenses(where),
    groupExpensesByCategory(where),
    groupExpensesByBuilding(where),
  ]);

  const buildingIds = buildingGroups
    .map((group) => group.buildingId)
    .filter((id): id is string => id !== null);

  const [categoryNames, buildingNames] = await Promise.all([
    categoryNamesByIds(categoryGroups.map((group) => group.categoryId)),
    buildingNamesByIds(buildingIds),
  ]);

  const byCategory = categoryGroups
    .map((group) => ({
      categoryId: group.categoryId,
      categoryName: categoryNames.get(group.categoryId) ?? 'Uncategorised',
      amount: paiseToRupees(group.amount),
    }))
    .sort((a, b) => b.amount - a.amount || a.categoryName.localeCompare(b.categoryName));

  // Buildings first (alphabetically, so the row order is stable month to month),
  // then the synthetic "Shared" row for unattributed costs.
  const byBuilding = buildingGroups
    .map((group) => ({
      buildingId: group.buildingId,
      buildingName:
        group.buildingId === null
          ? SHARED_LABEL
          : buildingNames.get(group.buildingId) ?? 'Unknown building',
      amount: paiseToRupees(group.amount),
    }))
    .sort((a, b) => {
      if (a.buildingId === null) return 1;
      if (b.buildingId === null) return -1;
      return a.buildingName.localeCompare(b.buildingName);
    });

  return {
    items: rows.map(toExpenseDto),
    total: aggregate.count,
    totals: {
      total: paiseToRupees(aggregate.total),
      count: aggregate.count,
      byCategory,
      byBuilding,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Validation of the two foreign keys
 * ------------------------------------------------------------------ */

async function assertCategoryExists(categoryId: string): Promise<void> {
  const category = await prisma.expenseCategory.findUnique({
    where: { id: categoryId },
    select: { id: true },
  });
  if (!category) throw categoryNotFound();
}

async function assertBuildingExists(buildingId: string): Promise<void> {
  const building = await prisma.building.findUnique({
    where: { id: buildingId },
    select: { id: true },
  });
  if (!building) throw buildingNotFound();
}

/**
 * `null`, an omitted value and the "shared" sentinel all mean the same thing:
 * a cost that has not been attributed to one building.
 */
const normaliseBuildingId = (value: string | null | undefined): string | null =>
  value && value !== SHARED_BUILDING ? value : null;

const summarise = (expense: ExpenseDto): string =>
  `${expense.categoryName} bill of ${expense.amount} dated ${expense.date} (${expense.buildingName ?? SHARED_LABEL})`;

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

export async function createExpense(
  input: CreateExpenseInput,
  auth: AuthContext,
): Promise<ExpenseDto> {
  await ensureDefaultCategories();

  const buildingId = normaliseBuildingId(input.buildingId);
  await assertCategoryExists(input.categoryId);
  if (buildingId) await assertBuildingExists(buildingId);

  const data: ExpenseWriteData = {
    date: isoDateToUtcDate(input.date),
    buildingId,
    categoryId: input.categoryId,
    amount: rupeesToPaise(input.amount),
    vendor: input.vendor ?? null,
    referenceNumber: input.referenceNumber ?? null,
    note: input.note ?? null,
    createdById: auth.userId || null,
  };

  return prisma.$transaction(async (tx) => {
    const created = await insertExpense(tx, data);
    const dto = toExpenseDto(created);
    await recordAudit(tx, {
      auth,
      action: 'CREATE',
      entityType: 'EXPENSE',
      entityId: dto.id,
      summary: `Logged ${summarise(dto)}`,
      newData: dto,
    });
    return dto;
  });
}

export async function updateExpense(
  id: string,
  input: UpdateExpenseInput,
  auth: AuthContext,
): Promise<ExpenseDto> {
  const existing = await findExpenseById(id);
  if (!existing) throw expenseNotFound();

  const data: Partial<Omit<ExpenseWriteData, 'createdById'>> = {};

  if (provided(input, 'date') && input.date !== undefined) {
    data.date = isoDateToUtcDate(input.date);
  }
  if (provided(input, 'categoryId') && input.categoryId !== undefined) {
    await assertCategoryExists(input.categoryId);
    data.categoryId = input.categoryId;
  }
  if (provided(input, 'buildingId')) {
    const buildingId = normaliseBuildingId(input.buildingId);
    if (buildingId) await assertBuildingExists(buildingId);
    data.buildingId = buildingId;
  }
  if (provided(input, 'amount') && input.amount !== undefined) {
    data.amount = rupeesToPaise(input.amount);
  }
  if (provided(input, 'vendor')) data.vendor = input.vendor ?? null;
  if (provided(input, 'referenceNumber')) data.referenceNumber = input.referenceNumber ?? null;
  if (provided(input, 'note')) data.note = input.note ?? null;

  const before = toExpenseDto(existing);

  return prisma.$transaction(async (tx) => {
    const updated = await updateExpenseRow(tx, id, data);
    const dto = toExpenseDto(updated);
    await recordAudit(tx, {
      auth,
      action: 'UPDATE',
      entityType: 'EXPENSE',
      entityId: id,
      summary: `Updated ${summarise(dto)}`,
      oldData: before,
      newData: dto,
    });
    return dto;
  });
}

export interface ExpenseDeletionResult {
  id: string;
  removed: true;
}

/**
 * Expenses are the one financial record that is genuinely deleted: no payment,
 * resident or staff row points at a bill, so removing it orphans nothing. The
 * audit entry carries the full record, so the deletion is still reversible by
 * hand and always attributable.
 */
export async function deleteExpense(
  id: string,
  auth: AuthContext,
): Promise<ExpenseDeletionResult> {
  const existing: ExpenseWithRelations | null = await findExpenseById(id);
  if (!existing) throw expenseNotFound();
  const before = toExpenseDto(existing);

  return prisma.$transaction(async (tx) => {
    await deleteExpenseRow(tx, id);
    await recordAudit(tx, {
      auth,
      action: 'DELETE',
      entityType: 'EXPENSE',
      entityId: id,
      summary: `Removed ${summarise(before)}`,
      oldData: before,
    });
    return { id, removed: true as const };
  });
}
