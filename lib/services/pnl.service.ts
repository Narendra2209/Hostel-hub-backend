/**
 * Profit & loss.
 *
 * BASIS: CASH.
 * -----------
 * The statement reports money that actually moved.
 *
 *  * `collected` is rent **received for** the selected billing month - the sum
 *    the fee engine allocates to that month (`monthPosition().paid`), which is
 *    what the reference implementation's `pnl()` summed. A payment recorded in
 *    September that settles August rent belongs to August here.
 *  * `billed` is the rent the fee engine *expects* from every resident enrolled
 *    that month. It is a memo line, never income.
 *  * `arrears` is the part of that month's billing still unpaid whose due date
 *    has already passed - the number the footer uses to explain the gap between
 *    billed and collected.
 *  * `expenses` is bills dated in the month plus salary payments *for* that
 *    salary month, mirroring the billing-month treatment of rent.
 *  * `net` is the cash result, `collected - expenses`.
 *  * `accrual` is the "if everyone paid" memo, `billed - expenses`. It is shown
 *    beside the cash figure, never instead of it.
 *
 * Archived residents are included. Archiving is an administrative act on a
 * person; it must never make rent they actually paid disappear from a financial
 * statement. What a resident is billed for is governed solely by the fee
 * engine's enrolment window (joining month through vacating month).
 *
 * Every amount below is a whole number of PAISE until the very last step, where
 * `paiseToRupees` builds the DTO. Nothing here divides, so no total can drift.
 *
 * Query budget: settings, buildings, roster + ledger (2), the year's expenses,
 * the year's salary payments, and one grouped scan of the year's fee payments -
 * about seven round trips regardless of how many buildings or months are in
 * scope. The twelve-month strip is folded in memory from those same rows; there
 * is no per-month and no per-building query anywhere in this file.
 */
import type { MonthKey, PnlColumnDto, PnlMonthRowDto, PnlResponseDto } from '@hostel/shared';
import { monthsOfYear, utcDateToMonthKey } from '@hostel/shared';
import { prisma } from '../db/prisma';
import { toPaise, paiseToRupees, ZERO, type Paise } from '../db/money';
import { buildingNotFound } from '../errors/app-error';
import { getFeeContext } from './settings.service';
import { asFeeResidents, loadRosterWithLedger, type RosterResident } from './roster.service';
import {
  monthPosition,
  monthTotals,
  type FeeContext,
  type PaymentIndex,
} from './fee-engine';
import { findExpensesInRange } from '../repositories/expense.repository';
import {
  isAllBuildings,
  isSharedOnly,
  monthDateRange,
  monthSpanRange,
  nullableBuildingWhere,
  residentBuildingWhere,
  type BuildingFilter,
} from '../repositories/filters';

export interface PnlQuery {
  month?: MonthKey;
  buildingId: BuildingFilter;
  year?: number;
}

/** The label for costs that were never attributed to one building. */
const SHARED_LABEL = 'Shared';
const TOTAL_LABEL = 'Total';
/** Map key standing in for "no building". */
const SHARED_KEY = ' shared';

/* ------------------------------------------------------------------ *
 * Row shapes loaded once per request
 * ------------------------------------------------------------------ */

interface SalaryRangeRow {
  salaryMonth: Date;
  /** Paise. */
  amount: number;
  staff: { buildingId: string | null };
}

function findSalaryPaymentsInRange(
  range: { gte: Date; lt: Date },
  filter: BuildingFilter,
): Promise<SalaryRangeRow[]> {
  return prisma.salaryPayment.findMany({
    where: {
      salaryMonth: range,
      ...(isAllBuildings(filter) ? {} : { staff: nullableBuildingWhere(filter) }),
    },
    select: {
      salaryMonth: true,
      amount: true,
      staff: { select: { buildingId: true } },
    },
  });
}

/**
 * Rent received per billing month across the whole year, in one grouped query.
 * `billingMonth` is always the first of a month, so this returns at most twelve
 * rows however large the ledger is.
 *
 * `_sum.amount` over an Int column comes back as `number | null`, hence the
 * `toPaise` on every row.
 *
 * This is the ledger's own sum. The month columns instead ask the fee engine
 * (`monthTotals().paid`), which ignores a payment filed against a month the
 * resident was not enrolled in - so a misfiled payment can show in the year
 * strip without showing in that month's column. That is intentional: the strip
 * is a cash trace, the column is a billing statement.
 */
async function collectedByBillingMonth(
  range: { gte: Date; lt: Date },
  filter: BuildingFilter,
): Promise<Map<MonthKey, Paise>> {
  // No resident is ever "shared", so that filter can only ever match nothing.
  if (isSharedOnly(filter)) return new Map();

  const rows = await prisma.feePayment.groupBy({
    by: ['billingMonth'],
    where: {
      billingMonth: range,
      ...(isAllBuildings(filter) ? {} : { resident: residentBuildingWhere(filter) }),
    },
    _sum: { amount: true },
  });

  return new Map(
    rows.map((row) => [utcDateToMonthKey(row.billingMonth), toPaise(row._sum.amount)] as const),
  );
}

/* ------------------------------------------------------------------ *
 * Column accumulators. Every amount is paise.
 * ------------------------------------------------------------------ */

interface ColumnAccumulator {
  buildingId: string | null;
  buildingName: string;
  shared: boolean;
  billed: Paise;
  collected: Paise;
  arrears: Paise;
  /** categoryId -> amount for this column only. */
  categories: Map<string, Paise>;
  bills: Paise;
  salaries: Paise;
}

const emptyColumn = (
  buildingId: string | null,
  buildingName: string,
  shared: boolean,
): ColumnAccumulator => ({
  buildingId,
  buildingName,
  shared,
  billed: ZERO,
  collected: ZERO,
  arrears: ZERO,
  categories: new Map(),
  bills: ZERO,
  salaries: ZERO,
});

interface CategoryRef {
  id: string;
  name: string;
  sortOrder: number;
}

function toColumnDto(column: ColumnAccumulator, order: CategoryRef[]): PnlColumnDto {
  const categories = order
    .filter((category) => column.categories.has(category.id))
    .map((category) => ({
      categoryId: category.id,
      categoryName: category.name,
      amount: paiseToRupees(column.categories.get(category.id) ?? ZERO),
    }));

  const expenses: Paise = column.bills + column.salaries;

  return {
    buildingId: column.buildingId,
    buildingName: column.buildingName,
    shared: column.shared,
    billed: paiseToRupees(column.billed),
    collected: paiseToRupees(column.collected),
    arrears: paiseToRupees(column.arrears),
    categories,
    billsTotal: paiseToRupees(column.bills),
    salaries: paiseToRupees(column.salaries),
    expenses: paiseToRupees(expenses),
    net: paiseToRupees(column.collected - expenses),
    accrual: paiseToRupees(column.billed - expenses),
  };
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

export async function buildPnl(query: PnlQuery): Promise<PnlResponseDto> {
  const { context } = await getFeeContext();
  const month = query.month ?? context.currentMonth;
  const year = query.year ?? Number(month.slice(0, 4));
  const filter = query.buildingId;

  const buildings = await loadColumnsBuildings(filter);

  const yearRange = monthSpanRange(`${year}-01`, `${year}-12`);
  const monthIsInYear = month.slice(0, 4) === String(year);

  const [ledger, yearExpenses, yearSalaries, yearCollected] = await Promise.all([
    loadRosterWithLedger(context, {
      buildingId: filter,
      includeArchived: true,
      range: 'month',
      month,
    }),
    findExpensesInRange(yearRange, filter),
    findSalaryPaymentsInRange(yearRange, filter),
    collectedByBillingMonth(yearRange, filter),
  ]);

  // The selected month usually lies inside the requested year, in which case its
  // rows are already loaded and are simply sliced out of the year's.
  const [monthExpenses, monthSalaries] = monthIsInYear
    ? [
        yearExpenses.filter((row) => utcDateToMonthKey(row.date) === month),
        yearSalaries.filter((row) => utcDateToMonthKey(row.salaryMonth) === month),
      ]
    : await Promise.all([
        findExpensesInRange(monthDateRange(month), filter),
        findSalaryPaymentsInRange(monthDateRange(month), filter),
      ]);

  /* ---- columns, in a stable order ---- */

  const ordered: ColumnAccumulator[] = buildings.map((building) =>
    emptyColumn(building.id, building.name, false),
  );
  const byKey = new Map<string, ColumnAccumulator>(
    ordered.map((column) => [column.buildingId ?? SHARED_KEY, column] as const),
  );
  const names = new Map(buildings.map((building) => [building.id, building.name] as const));

  // The shared column exists only when something in the month is unattributed.
  // When the caller explicitly asked for "shared" it is always present, even
  // empty, so the screen has a column to render.
  const sharedColumn = (): ColumnAccumulator => {
    const existing = byKey.get(SHARED_KEY);
    if (existing) return existing;
    const created = emptyColumn(null, SHARED_LABEL, true);
    byKey.set(SHARED_KEY, created);
    ordered.push(created);
    return created;
  };
  if (isSharedOnly(filter)) sharedColumn();

  const columnFor = (buildingId: string | null): ColumnAccumulator => {
    if (buildingId === null) return sharedColumn();
    const existing = byKey.get(buildingId);
    if (existing) return existing;
    // Defensive: a building that exists on a row but not in the filtered list.
    const created = emptyColumn(buildingId, names.get(buildingId) ?? 'Unknown building', false);
    byKey.set(buildingId, created);
    ordered.push(created);
    return created;
  };

  /* ---- income: billed, collected, arrears ---- */

  const residentsByBuilding = new Map<string, RosterResident[]>();
  for (const resident of ledger.residents) {
    const bucket = residentsByBuilding.get(resident.buildingId);
    if (bucket) bucket.push(resident);
    else residentsByBuilding.set(resident.buildingId, [resident]);
  }

  for (const [buildingId, residents] of residentsByBuilding) {
    const column = columnFor(buildingId);
    const totals = monthTotals(asFeeResidents(residents), month, ledger.index, context);
    column.billed += totals.expected;
    column.collected += totals.paid;
    column.arrears += overdueBalance(residents, month, ledger.index, context);
  }

  /* ---- costs: bills by category, then salaries ---- */

  const categoryOrder = new Map<string, CategoryRef>();

  for (const row of monthExpenses) {
    const column = columnFor(row.buildingId);
    const amount = toPaise(row.amount);
    column.bills += amount;
    column.categories.set(
      row.category.id,
      (column.categories.get(row.category.id) ?? ZERO) + amount,
    );
    if (!categoryOrder.has(row.category.id)) categoryOrder.set(row.category.id, row.category);
  }

  for (const row of monthSalaries) {
    const column = columnFor(row.staff.buildingId);
    column.salaries += toPaise(row.amount);
  }

  /* ---- the union of categories present, in one stable order ---- */

  const categoryRefs = [...categoryOrder.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );

  /* ---- total everything in scope ---- */

  // `ordered` already holds exactly the right columns: one per building in
  // scope, plus the shared column if and only if the month had an unattributed
  // cost (or the caller asked for "shared" explicitly).
  const columns = ordered;

  const total = emptyColumn(null, TOTAL_LABEL, false);
  for (const column of columns) {
    total.billed += column.billed;
    total.collected += column.collected;
    total.arrears += column.arrears;
    total.bills += column.bills;
    total.salaries += column.salaries;
    for (const [categoryId, amount] of column.categories) {
      total.categories.set(categoryId, (total.categories.get(categoryId) ?? ZERO) + amount);
    }
  }

  /* ---- the Jan-Dec strip, folded from the rows already in memory ---- */

  const billsByMonth = foldByMonth(
    yearExpenses,
    (row) => row.date,
    (row) => row.amount,
  );
  const salariesByMonth = foldByMonth(
    yearSalaries,
    (row) => row.salaryMonth,
    (row) => row.amount,
  );

  let yearCollectedTotal: Paise = ZERO;
  let yearExpenseTotal: Paise = ZERO;
  let peak = 0;

  const yearToDate: PnlMonthRowDto[] = monthsOfYear(year).map((key) => {
    const collected = yearCollected.get(key) ?? ZERO;
    const spent: Paise = (billsByMonth.get(key) ?? ZERO) + (salariesByMonth.get(key) ?? ZERO);
    yearCollectedTotal += collected;
    yearExpenseTotal += spent;

    const row: PnlMonthRowDto = {
      month: key,
      collected: paiseToRupees(collected),
      expenses: paiseToRupees(spent),
      net: paiseToRupees(collected - spent),
    };
    // The bars are sized in rupees, against the rupee figures the row carries.
    peak = Math.max(peak, row.collected, row.expenses);
    return row;
  });

  return {
    month,
    basis: 'CASH',
    columns: columns.map((column) => toColumnDto(column, categoryRefs)),
    total: toColumnDto(total, categoryRefs),
    categoryNames: categoryRefs.map((category) => ({
      categoryId: category.id,
      categoryName: category.name,
    })),
    year,
    yearToDate,
    yearTotals: {
      collected: paiseToRupees(yearCollectedTotal),
      expenses: paiseToRupees(yearExpenseTotal),
      net: paiseToRupees(yearCollectedTotal - yearExpenseTotal),
    },
    // The bars are scaled against this, so it can never be zero.
    peak: Math.max(1, peak),
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function loadColumnsBuildings(
  filter: BuildingFilter,
): Promise<{ id: string; name: string }[]> {
  if (isSharedOnly(filter)) return [];
  if (isAllBuildings(filter)) {
    return prisma.building.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true },
    });
  }
  const building = await prisma.building.findUnique({
    where: { id: filter },
    select: { id: true, name: true },
  });
  if (!building) throw buildingNotFound();
  return [building];
}

/** That month's unpaid balance whose due date is already behind us, in paise. */
function overdueBalance(
  residents: RosterResident[],
  month: MonthKey,
  index: PaymentIndex,
  context: FeeContext,
): Paise {
  let arrears: Paise = ZERO;
  for (const resident of residents) {
    const position = monthPosition(resident, month, index, context);
    if (position.overdue) arrears += position.balance;
  }
  return arrears;
}

/** Fold dated rows into monthKey -> summed paise, in one pass. */
function foldByMonth<TRow>(
  rows: TRow[],
  dateOf: (row: TRow) => Date,
  amountOf: (row: TRow) => number,
): Map<MonthKey, Paise> {
  const totals = new Map<MonthKey, Paise>();
  for (const row of rows) {
    const key = utcDateToMonthKey(dateOf(row));
    totals.set(key, (totals.get(key) ?? ZERO) + toPaise(amountOf(row)));
  }
  return totals;
}
