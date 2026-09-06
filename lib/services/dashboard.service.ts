/**
 * The Overview dashboard.
 *
 * The screen renders six stat cards, a building-by-building table, the "who
 * owes money" list, the Jan-Dec fee cards, the bills breakdown and the salary
 * run. All of it comes from ONE request, and that request is a small constant
 * number of queries no matter how many residents, staff or bills exist:
 *
 *   1  settings (resolves "today" and the default due day)
 *   2  roster + fee-payment ledger        (loadRosterWithLedger)
 *   1  buildings
 *   1  staff in scope
 *   1  salary payments this month, grouped by staff       (groupBy)
 *   1  expenses this month, grouped by category + building (groupBy)
 *   2  expense categories (bootstrap count + read)
 *   2  the fee-strip residents' calendar-year ledger
 *
 * Everything else is in-memory folding of those results. No query is ever
 * issued inside a per-resident, per-staff or per-month loop, and every rupee is
 * added up as a whole number of paise - rupees appear only when the DTO is
 * built, through `paiseToRupees`.
 *
 * Two deliberate rules from the reference implementation are preserved here:
 *  * financial semantics come from the fee engine, never from a re-derivation;
 *  * shared costs (a bill or a salary with no building attached) are reported
 *    in their own row and are NEVER allocated across the buildings.
 */
import type { z } from 'zod';
import type {
  BuildingSummaryDto,
  DashboardDto,
  ExpenseBreakdownItemDto,
  FeeStatusStripDto,
  MonthKey,
  SalarySummaryItemDto,
  dashboardQuerySchema,
} from '@hostel/shared';
import { balanceOf, maxPaise, toPaise, paiseToRupees, ZERO, type Paise } from '../db/money';
import { prisma, type PrismaLike } from '../db/prisma';
import { buildingNotFound } from '../errors/app-error';
import {
  isAllBuildings,
  isSharedOnly,
  monthDateRange,
  nullableBuildingWhere,
} from '../repositories/filters';
import { isEnrolled, monthTotals, yearStrip, type PaymentIndex } from './fee-engine';
import { salaryStatus } from './mappers';
import { buildOverdueSnapshot } from './overdue.service';
import { loadRosterWithLedger, type RosterResident } from './roster.service';
import { getFeeContext, listCategories } from './settings.service';

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

/** The synthetic column for costs nobody has attributed to a building. */
const SHARED_ROW_NAME = 'Shared, not assigned';
const ALL_BUILDINGS_LABEL = 'All buildings';
const UNASSIGNED_BUILDING = 'Unassigned';
/** The "who owes money" card shows the largest debts and links to /overdue. */
const OVERDUE_CARD_LIMIT = 12;
/** Places kept on the 0..1 bar-width ratio in the bills breakdown. */
const SHARE_PRECISION = 4;

/** A building column while it is still being added up. Every amount is paise. */
interface BuildingColumn {
  buildingId: string | null;
  buildingName: string;
  shared: boolean;
  residentCount: number;
  billed: Paise;
  collected: Paise;
  overdue: Paise;
  bills: Paise;
  salaries: Paise;
}

const columnNet = (column: BuildingColumn): Paise =>
  column.collected - column.bills - column.salaries;

const toBuildingSummaryDto = (column: BuildingColumn): BuildingSummaryDto => ({
  buildingId: column.buildingId,
  buildingName: column.buildingName,
  shared: column.shared,
  residentCount: column.residentCount,
  billed: paiseToRupees(column.billed),
  collected: paiseToRupees(column.collected),
  overdue: paiseToRupees(column.overdue),
  bills: paiseToRupees(column.bills),
  salaries: paiseToRupees(column.salaries),
  net: paiseToRupees(columnNet(column)),
});

/** Accumulate into a map keyed by building id, with `null` for shared costs. */
function addTo(map: Map<string | null, Paise>, key: string | null, amount: Paise): void {
  map.set(key, (map.get(key) ?? ZERO) + amount);
}

/* ------------------------------------------------------------------ *
 * The endpoint
 * ------------------------------------------------------------------ */

export async function getDashboard(
  query: DashboardQuery,
  client: PrismaLike = prisma,
): Promise<DashboardDto> {
  const { context } = await getFeeContext(client);
  const month: MonthKey = query.month ?? context.currentMonth;
  const stripYear = query.year ?? Number(month.slice(0, 4));
  const filter = query.buildingId;
  const monthRange = monthDateRange(month);

  // Six independent reads. They do not depend on one another, so they go out
  // together and the endpoint costs one round trip rather than six.
  const [buildings, ledger, staffRows, salaryGroups, expenseGroups, categories] = await Promise.all(
    [
      client.building.findMany({
        select: { id: true, name: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      loadRosterWithLedger(context, { buildingId: filter, range: 'history', month }, client),
      client.staff.findMany({
        where: nullableBuildingWhere(filter),
        select: {
          id: true,
          name: true,
          role: true,
          buildingId: true,
          monthlySalary: true,
          active: true,
        },
        orderBy: { name: 'asc' },
      }),
      client.salaryPayment.groupBy({
        by: ['staffId'],
        where: {
          salaryMonth: monthRange,
          // A relation filter costs a lookup on MongoDB, so "all buildings"
          // asks for no filter at all rather than an empty one.
          ...(isAllBuildings(filter) ? {} : { staff: nullableBuildingWhere(filter) }),
        },
        _sum: { amount: true },
      }),
      client.expense.groupBy({
        by: ['categoryId', 'buildingId'],
        where: { date: monthRange, ...nullableBuildingWhere(filter) },
        _sum: { amount: true },
      }),
      listCategories({ includeInactive: true }),
    ],
  );

  const buildingNameById = new Map(buildings.map((building) => [building.id, building.name]));

  // A filter pointing at a building that no longer exists is a client bug, not
  // an empty dashboard - say so rather than silently reporting zeroes.
  if (!isAllBuildings(filter) && !isSharedOnly(filter) && !buildingNameById.has(filter)) {
    throw buildingNotFound();
  }

  /* -------------------------------------------------------------- *
   * Fees: the whole roster, then the same figures per building.
   * -------------------------------------------------------------- */

  const totals = monthTotals(ledger.residents, month, ledger.index, context);
  const snapshot = buildOverdueSnapshot(ledger.residents, ledger.index, context);

  const residentsByBuilding = new Map<string, RosterResident[]>();
  for (const resident of ledger.residents) {
    const bucket = residentsByBuilding.get(resident.buildingId);
    if (bucket) bucket.push(resident);
    else residentsByBuilding.set(resident.buildingId, [resident]);
  }

  /* -------------------------------------------------------------- *
   * Costs: bills by category and by building, salaries by staff.
   *
   * A `_sum` over an Int column now arrives as `number | null`, so every
   * grouped total is put through `toPaise` before it is added to anything.
   * -------------------------------------------------------------- */

  const billsByBuilding = new Map<string | null, Paise>();
  const billsByCategory = new Map<string, Paise>();
  let expenseTotal: Paise = ZERO;

  for (const group of expenseGroups) {
    const amount = toPaise(group._sum.amount);
    expenseTotal += amount;
    addTo(billsByBuilding, group.buildingId, amount);
    billsByCategory.set(
      group.categoryId,
      (billsByCategory.get(group.categoryId) ?? ZERO) + amount,
    );
  }

  const staffById = new Map(staffRows.map((staff) => [staff.id, staff]));
  const salaryPaidByStaff = new Map<string, Paise>();
  const salariesByBuilding = new Map<string | null, Paise>();
  let salaryPaidTotal: Paise = ZERO;

  for (const group of salaryGroups) {
    const amount = toPaise(group._sum.amount);
    salaryPaidTotal += amount;
    salaryPaidByStaff.set(group.staffId, amount);
    // Salaries are attributed through the staff member's building; a member who
    // works across the hostel has none, so the money lands in the shared row.
    addTo(salariesByBuilding, staffById.get(group.staffId)?.buildingId ?? null, amount);
  }

  /* -------------------------------------------------------------- *
   * Building-by-building table.
   * -------------------------------------------------------------- */

  // "shared" is a cost-only filter, so it contributes no building columns.
  const scopeBuildings = isAllBuildings(filter)
    ? buildings
    : isSharedOnly(filter)
      ? []
      : buildings.filter((building) => building.id === filter);

  const columns: BuildingColumn[] = scopeBuildings.map((building) => {
    const residents = residentsByBuilding.get(building.id) ?? [];
    const buildingTotals = monthTotals(residents, month, ledger.index, context);
    return {
      buildingId: building.id,
      buildingName: building.name,
      shared: false,
      residentCount: buildingTotals.residentCount,
      billed: buildingTotals.expected,
      collected: buildingTotals.paid,
      // The snapshot's arrears are already paise, so they add straight in.
      overdue: snapshot.overdueByBuilding.get(building.id) ?? ZERO,
      bills: billsByBuilding.get(building.id) ?? ZERO,
      salaries: salariesByBuilding.get(building.id) ?? ZERO,
    };
  });

  // Never spread shared costs across the buildings - they get their own row.
  const sharedColumn: BuildingColumn = {
    buildingId: null,
    buildingName: SHARED_ROW_NAME,
    shared: true,
    residentCount: 0,
    billed: ZERO,
    collected: ZERO,
    overdue: ZERO,
    bills: billsByBuilding.get(null) ?? ZERO,
    salaries: salariesByBuilding.get(null) ?? ZERO,
  };

  const allColumns = [...columns, sharedColumn];

  const summaryTotals = allColumns.reduce<BuildingColumn>(
    (acc, column) => ({
      ...acc,
      residentCount: acc.residentCount + column.residentCount,
      billed: acc.billed + column.billed,
      collected: acc.collected + column.collected,
      overdue: acc.overdue + column.overdue,
      bills: acc.bills + column.bills,
      salaries: acc.salaries + column.salaries,
    }),
    {
      buildingId: null,
      buildingName: ALL_BUILDINGS_LABEL,
      shared: false,
      residentCount: 0,
      billed: ZERO,
      collected: ZERO,
      overdue: ZERO,
      bills: ZERO,
      salaries: ZERO,
    },
  );

  /* -------------------------------------------------------------- *
   * Bills breakdown - `share` sizes the bar, so it is relative to the
   * largest category rather than to the total. It is a 0..1 ratio and
   * not money, so it is the one number here that stays a float and is
   * never routed through paiseToRupees.
   * -------------------------------------------------------------- */

  const categoryNameById = new Map(
    categories.map((category) => [category.id, category.name] as const),
  );

  const largestCategory = maxPaise([...billsByCategory.values()]);

  const expenseBreakdown: ExpenseBreakdownItemDto[] = [...billsByCategory.entries()]
    .map(([categoryId, amount]) => ({
      categoryId,
      categoryName: categoryNameById.get(categoryId) ?? 'Uncategorised',
      amount: paiseToRupees(amount),
      share:
        largestCategory === ZERO ? 0 : Number((amount / largestCategory).toFixed(SHARE_PRECISION)),
    }))
    .sort((a, b) => b.amount - a.amount || a.categoryName.localeCompare(b.categoryName));

  /* -------------------------------------------------------------- *
   * Salary run for the month - active staff only.
   * -------------------------------------------------------------- */

  const salarySummary: SalarySummaryItemDto[] = staffRows
    .filter((staff) => staff.active)
    .map((staff) => {
      const salary = toPaise(staff.monthlySalary);
      const paid = salaryPaidByStaff.get(staff.id) ?? ZERO;
      // balanceOf clamps at zero, so an overpayment never reads as a credit.
      const balance = balanceOf(salary, paid);
      return {
        staffId: staff.id,
        name: staff.name,
        role: staff.role,
        buildingId: staff.buildingId,
        buildingName: staff.buildingId
          ? (buildingNameById.get(staff.buildingId) ?? UNASSIGNED_BUILDING)
          : null,
        salary: paiseToRupees(salary),
        paid: paiseToRupees(paid),
        balance: paiseToRupees(balance),
        // salaryStatus only compares its two amounts, so it is given the exact
        // paise figures rather than the rounded rupee ones.
        status: salaryStatus(salary, paid, staff.active),
      };
    });

  /* -------------------------------------------------------------- *
   * Fee cards: the first `stripLimit` residents staying this month.
   * One extra ledger load, scoped to the calendar year on show.
   * -------------------------------------------------------------- */

  const stripCandidates = ledger.residents.filter((resident) => isEnrolled(resident, month));
  const stripIds = stripCandidates.slice(0, query.stripLimit).map((resident) => resident.id);
  const feeStripTruncated = stripCandidates.length > stripIds.length;

  let stripResidents: RosterResident[] = [];
  let stripIndex: PaymentIndex = new Map();
  if (stripIds.length > 0) {
    const strip = await loadRosterWithLedger(
      context,
      { residentIds: stripIds, range: 'year', year: stripYear },
      client,
    );
    stripResidents = strip.residents;
    stripIndex = strip.index;
  }

  const feeStrips: FeeStatusStripDto[] = stripResidents.map((resident) => ({
    residentId: resident.id,
    year: stripYear,
    months: yearStrip(resident, stripYear, stripIndex, context),
  }));

  /* -------------------------------------------------------------- *
   * Headline figures.
   * -------------------------------------------------------------- */

  const collectedFees: Paise = totals.paid;
  const totalSpent: Paise = salaryPaidTotal + expenseTotal;

  return {
    month,
    buildingId: isAllBuildings(filter) || isSharedOnly(filter) ? null : filter,
    buildingName: isAllBuildings(filter)
      ? ALL_BUILDINGS_LABEL
      : isSharedOnly(filter)
        ? SHARED_ROW_NAME
        : (buildingNameById.get(filter) ?? UNASSIGNED_BUILDING),
    buildingCount: buildings.length,
    residentCount: totals.residentCount,
    expectedFees: paiseToRupees(totals.expected),
    collectedFees: paiseToRupees(collectedFees),
    outstandingThisMonth: paiseToRupees(totals.balance),
    overdueAllMonths: paiseToRupees(snapshot.totalOverdue),
    overdueResidentCount: snapshot.totals.residentCount,
    salaryPaid: paiseToRupees(salaryPaidTotal),
    expenses: paiseToRupees(expenseTotal),
    totalSpent: paiseToRupees(totalSpent),
    net: paiseToRupees(collectedFees - totalSpent),
    buildingSummary: allColumns.map(toBuildingSummaryDto),
    buildingSummaryTotals: {
      residentCount: summaryTotals.residentCount,
      billed: paiseToRupees(summaryTotals.billed),
      collected: paiseToRupees(summaryTotals.collected),
      overdue: paiseToRupees(summaryTotals.overdue),
      bills: paiseToRupees(summaryTotals.bills),
      salaries: paiseToRupees(summaryTotals.salaries),
      net: paiseToRupees(columnNet(summaryTotals)),
    },
    // Already sorted largest debt first by the snapshot.
    overdueResidents: snapshot.residents.slice(0, OVERDUE_CARD_LIMIT),
    overdueResidentTotal: snapshot.residents.length,
    expenseBreakdown,
    salarySummary,
    feeStrips,
    feeStripResidents: stripResidents.map((resident) => ({
      residentId: resident.id,
      name: resident.name,
      buildingName: resident.building?.name ?? UNASSIGNED_BUILDING,
      monthlyFee: paiseToRupees(resident.monthlyFee),
    })),
    feeStripYear: stripYear,
    feeStripTruncated,
  };
}
