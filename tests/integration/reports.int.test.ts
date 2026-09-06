/**
 * The three reporting surfaces, against a real MongoDB replica set.
 *
 *  * the Overview dashboard, where a cost nobody attributed to a building has
 *    to stay in its own row and must never be smeared across the buildings;
 *  * the P&L, which is a CASH statement: collected minus (bills + salaries);
 *  * the overdue screen, which has to reach back across several months.
 *
 * The dashboard is hostel-wide by definition, so that test measures a delta
 * across the call under test. The P&L and the overdue screen are scoped to a
 * building this run created, which makes the register invisible to them.
 *
 * Every figure asserted here comes off a DTO, so every figure here is in
 * rupees; the paise the aggregates were summed in never leave the services.
 * Fixture inputs are rupees too, exactly like a request body.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  BuildingSummaryDto,
  DashboardDto,
  OverdueResidentDto,
  OverdueRowDto,
} from '@hostel/shared';
import {
  dashboardQuerySchema,
  dueDateForMonth,
  daysBetween,
  isPastDueDate,
  overdueQuerySchema,
} from '@hostel/shared';
import { getDashboard } from '../../lib/services/dashboard.service';
import { getOverdue } from '../../lib/services/overdue.service';
import { buildPnl } from '../../lib/services/pnl.service';
import {
  Fixtures,
  dayIn,
  disconnect,
  integrationSuite,
  monthsAgo,
  monthsAhead,
  must,
  today,
} from '../helpers/db';

const suite = await integrationSuite();
const fixtures = new Fixtures();

const dashboardFor = (month: string): Promise<DashboardDto> =>
  getDashboard(dashboardQuerySchema.parse({ month, buildingId: 'all', stripLimit: 0 }));

const columnFor = (dashboard: DashboardDto, buildingId: string): BuildingSummaryDto =>
  must(
    dashboard.buildingSummary.find((column) => column.buildingId === buildingId),
    `a dashboard column for building ${buildingId}`,
  );

const sharedRowOf = (dashboard: DashboardDto): BuildingSummaryDto =>
  must(
    dashboard.buildingSummary.find((column) => column.shared),
    'the shared dashboard row',
  );

/** Narrow one page item from the resident-grouped overdue list. */
const asResidentRow = (item: OverdueRowDto | OverdueResidentDto): OverdueResidentDto => {
  if ('totalOverdue' in item) return item;
  throw new Error('Expected a resident-grouped overdue row');
};

const asMonthRow = (item: OverdueRowDto | OverdueResidentDto): OverdueRowDto => {
  if ('month' in item) return item;
  throw new Error('Expected a month-grouped overdue row');
};

suite('reports (integration)', () => {
  beforeAll(async () => {
    await fixtures.setUp();
  });

  afterAll(async () => {
    await fixtures.tearDown();
    await disconnect();
  });

  it('keeps a shared cost in the shared row and out of every building', async () => {
    // Far enough ahead that the imported register has no costs of its own here,
    // and every figure below is still measured as a delta.
    const month = monthsAhead(6);
    const building = await fixtures.createBuilding('Dashboard block');
    await fixtures.createResident({
      name: 'Tara',
      buildingId: building.id,
      monthlyFee: 4000,
      dueDay: 5,
      joinMonth: monthsAgo(0),
    });
    const sharedStaff = await fixtures.createStaff({
      name: 'Night watchman',
      buildingId: null,
      monthlySalary: 9000,
    });

    const baseline = await dashboardFor(month);
    const baseColumn = columnFor(baseline, building.id);
    expect(baseColumn).toMatchObject({
      buildingName: building.name,
      shared: false,
      residentCount: 1,
      billed: 4000,
      collected: 0,
      bills: 0,
      salaries: 0,
    });
    const baseShared = sharedRowOf(baseline);

    await fixtures.createExpense({
      buildingId: null,
      date: dayIn(month, 12),
      amount: 1200,
      vendor: fixtures.label('Shared vendor'),
    });
    await fixtures.createExpense({
      buildingId: building.id,
      date: dayIn(month, 14),
      amount: 900,
      vendor: fixtures.label('Block vendor'),
    });
    await fixtures.createSalaryPayment({
      staffId: sharedStaff.id,
      salaryMonth: month,
      amount: 7000,
    });

    const after = await dashboardFor(month);
    const column = columnFor(after, building.id);
    const shared = sharedRowOf(after);

    // The building carries its own bill and nothing else - not 900 + 1200.
    expect(column.bills).toBe(900);
    expect(column.salaries).toBe(0);
    expect(column.net).toBe(column.collected - column.bills - column.salaries);

    // The unattributed bill and the hostel-wide salary land here, and only here.
    expect(shared.buildingId).toBeNull();
    expect(shared.shared).toBe(true);
    expect(shared.residentCount).toBe(0);
    expect(shared.billed).toBe(0);
    expect(shared.collected).toBe(0);
    expect(shared.overdue).toBe(0);
    expect(shared.bills - baseShared.bills).toBe(1200);
    expect(shared.salaries - baseShared.salaries).toBe(7000);

    // Exactly one shared row, listed alongside the buildings rather than folded in.
    expect(after.buildingSummary.filter((row) => row.shared)).toHaveLength(1);

    // Both costs still reach the hostel-wide totals.
    expect(after.buildingSummaryTotals.bills - baseline.buildingSummaryTotals.bills).toBe(2100);
    expect(after.buildingSummaryTotals.salaries - baseline.buildingSummaryTotals.salaries).toBe(
      7000,
    );
    expect(after.expenses - baseline.expenses).toBe(2100);
    expect(after.salaryPaid - baseline.salaryPaid).toBe(7000);
  });

  it('reports the P&L as collected minus bills and salaries, on a cash basis', async () => {
    const month = monthsAgo(1);
    const year = Number(month.slice(0, 4));
    const building = await fixtures.createBuilding('PnL block');

    const paidUp = await fixtures.createResident({
      name: 'Uma',
      buildingId: building.id,
      monthlyFee: 5000,
      dueDay: 5,
      joinMonth: month,
    });
    const behind = await fixtures.createResident({
      name: 'Vikram',
      buildingId: building.id,
      monthlyFee: 3000,
      dueDay: 5,
      joinMonth: month,
    });
    await fixtures.createPayment({ residentId: paidUp.id, billingMonth: month, amount: 5000 });
    await fixtures.createPayment({ residentId: behind.id, billingMonth: month, amount: 1000 });

    const category = await fixtures.anyCategory();
    await fixtures.createExpense({
      buildingId: building.id,
      date: dayIn(month, 15),
      amount: 2500,
      categoryId: category.id,
    });

    const cook = await fixtures.createStaff({
      name: 'Cook',
      buildingId: building.id,
      monthlySalary: 8000,
    });
    await fixtures.createSalaryPayment({ staffId: cook.id, salaryMonth: month, amount: 6000 });

    const pnl = await buildPnl({ month, buildingId: building.id, year });

    expect(pnl.basis).toBe('CASH');
    expect(pnl.month).toBe(month);
    expect(pnl.columns).toHaveLength(1);

    const column = must(pnl.columns[0], 'the building column');
    expect(column).toMatchObject({
      buildingId: building.id,
      buildingName: building.name,
      shared: false,
      billed: 8000,
      collected: 6000,
      // The part of this month's billing already past its due date.
      arrears: 2000,
      billsTotal: 2500,
      salaries: 6000,
      expenses: 8500,
      net: -2500,
      // The "if everyone paid" memo, beside the cash figure and never instead of it.
      accrual: -500,
    });
    // The statement's defining identity.
    expect(column.net).toBe(column.collected - (column.billsTotal + column.salaries));
    expect(column.categories).toEqual([
      { categoryId: category.id, categoryName: category.name, amount: 2500 },
    ]);

    expect(pnl.total).toMatchObject({
      billed: 8000,
      collected: 6000,
      billsTotal: 2500,
      salaries: 6000,
      expenses: 8500,
      net: -2500,
    });

    // The year strip is the same cash, folded by month.
    const strip = must(
      pnl.yearToDate.find((row) => row.month === month),
      `the ${month} row of the year strip`,
    );
    expect(strip).toEqual({ month, collected: 6000, expenses: 8500, net: -2500 });
    expect(pnl.yearTotals).toEqual({ collected: 6000, expenses: 8500, net: -2500 });
  });

  it('adds up arrears across more than one month and names the oldest', async () => {
    const oldest = monthsAgo(2);
    const middle = monthsAgo(1);
    const thisMonth = monthsAgo(0);
    const dueDay = 1;

    // The first of this month is behind us on every day except the 1st itself,
    // so the set of overdue months is derived rather than assumed.
    const overdueMonths = isPastDueDate(dueDateForMonth(thisMonth, dueDay), today())
      ? [oldest, middle, thisMonth]
      : [oldest, middle];
    expect(overdueMonths.length).toBeGreaterThan(1);

    const building = await fixtures.createBuilding('Overdue block');
    const debtor = await fixtures.createResident({
      name: 'Debtor',
      buildingId: building.id,
      monthlyFee: 7000,
      dueDay,
      joinMonth: oldest,
    });
    const partial = await fixtures.createResident({
      name: 'Partial',
      buildingId: building.id,
      monthlyFee: 5000,
      dueDay,
      joinMonth: oldest,
    });
    const settled = await fixtures.createResident({
      name: 'Settled',
      buildingId: building.id,
      monthlyFee: 4000,
      dueDay,
      joinMonth: oldest,
    });

    await fixtures.createPayment({ residentId: partial.id, billingMonth: oldest, amount: 2000 });
    for (const month of [oldest, middle, thisMonth]) {
      await fixtures.createPayment({ residentId: settled.id, billingMonth: month, amount: 4000 });
    }

    const months = overdueMonths.length;
    const debtorOwes = 7000 * months;
    const partialOwes = 3000 + 5000 * (months - 1);

    const byResident = await getOverdue(
      overdueQuerySchema.parse({ buildingId: building.id, groupBy: 'resident', pageSize: 100 }),
    );

    expect(byResident.totals.totalOverdue).toBe(debtorOwes + partialOwes);
    expect(byResident.totals.residentCount).toBe(2);
    expect(byResident.totals.stayingResidentCount).toBe(3);
    expect(byResident.totals.oldestDaysOverdue).toBe(
      daysBetween(dueDateForMonth(oldest, dueDay), today()),
    );
    expect(byResident.totals.oldestResidentName).toBe(fixtures.label('Debtor'));
    expect(byResident.total).toBe(2);

    const residentRows = byResident.items.map(asResidentRow);
    // Ordered largest debt first, so the dashboard card can take the top slice.
    expect(residentRows.map((row) => row.residentId)).toEqual([debtor.id, partial.id]);
    expect(residentRows[0]).toMatchObject({
      residentName: fixtures.label('Debtor'),
      buildingId: building.id,
      buildingName: building.name,
      totalOverdue: debtorOwes,
      oldestUnpaidMonth: oldest,
      numberOfOverdueMonths: months,
    });
    expect(residentRows[1]).toMatchObject({
      totalOverdue: partialOwes,
      oldestUnpaidMonth: oldest,
      numberOfOverdueMonths: months,
    });
    // Somebody who paid every month is not on the list at all.
    expect(residentRows.some((row) => row.residentId === settled.id)).toBe(false);

    const byMonth = await getOverdue(
      overdueQuerySchema.parse({ buildingId: building.id, groupBy: 'month', pageSize: 100 }),
    );
    const monthRows = byMonth.items.map(asMonthRow);
    expect(byMonth.total).toBe(2 * months);
    expect(
      monthRows.filter((row) => row.residentId === debtor.id).map((row) => row.month),
    ).toEqual(overdueMonths);

    const partialOldest = must(
      monthRows.find((row) => row.residentId === partial.id && row.month === oldest),
      `the ${oldest} row for the part-payer`,
    );
    expect(partialOldest).toMatchObject({
      expected: 5000,
      paid: 2000,
      balance: 3000,
      dueDate: dueDateForMonth(oldest, dueDay),
    });
    expect(partialOldest.daysOverdue).toBe(
      daysBetween(dueDateForMonth(oldest, dueDay), today()),
    );
  });
});
