/**
 * Fee engine unit tests.
 *
 * These are the most important tests in the repository: every balance, status,
 * overdue figure and dashboard total in the product comes out of this module.
 *
 * Three rules keep them honest:
 *  * every FeeContext is constructed explicitly, so no assertion depends on the
 *    real clock and a test cannot start failing on the 6th of a month;
 *  * every Date is built with `Date.UTC`, matching the UTC-midnight convention
 *    the MongoDB DateTime fields round-trip on;
 *  * EVERY AMOUNT IS INTEGER PAISE. A 4,500 rupee fee is the number 450000.
 *    Fixtures are written in paise, the engine's own figures are asserted in
 *    paise, and rupees appear only where a DTO is being checked - the single
 *    boundary where `paiseToRupees` is allowed to run.
 */
import { describe, expect, it } from 'vitest';
import type { MonthKey } from '@hostel/shared';
import { monthKeyToUtcDate } from '@hostel/shared';
import { sumPaise, toPaise, paiseToRupees, ZERO, type Paise } from '../db/money';
import { salaryStatus } from './mappers';
import {
  billableMonths,
  buildPaymentIndex,
  cashReceivedIn,
  createFeeContext,
  dueDateFor,
  earliestJoinMonth,
  effectiveDueDay,
  isEnrolled,
  isStaying,
  joinMonthOf,
  monthPosition,
  monthTotals,
  residentArrears,
  toMonthFeeStatusDto,
  toOverdueSummaryDto,
  vacatedMonthOf,
  yearStrip,
  type FeeContext,
  type FeePaymentRow,
  type FeeResident,
} from './fee-engine';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A UTC-midnight Date, exactly as the database stores a billing date. */
const utc = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month - 1, day));

/** Rs 5,000.00 a month, in paise. */
const MONTHLY_FEE: Paise = 500_000;

const makeResident = (overrides: Partial<FeeResident> & { id: string }): FeeResident => ({
  monthlyFee: MONTHLY_FEE,
  dueDay: 5,
  joinDate: utc(2026, 1, 1),
  vacatedDate: null,
  ...overrides,
});

const makePayment = (
  residentId: string,
  billingMonth: MonthKey,
  /** Paise, exactly as the stored field holds it. */
  amount: Paise,
): FeePaymentRow => ({
  residentId,
  billingMonth: monthKeyToUtcDate(billingMonth),
  amount,
});

/** A context frozen on a given day - never the real clock. */
const contextOn = (today: string, defaultDueDay = 5): FeeContext => ({
  today,
  currentMonth: today.slice(0, 7),
  defaultDueDay,
  timezone: 'Asia/Kolkata',
});

const noPayments = (): ReturnType<typeof buildPaymentIndex> => buildPaymentIndex([]);

/** Mirrors the P&L's column attribution: a null building goes to "Shared". */
const SHARED_KEY = ' shared';

function bucketCosts(rows: { buildingId: string | null; amount: Paise }[]): Map<string, Paise> {
  const buckets = new Map<string, Paise>();
  for (const row of rows) {
    const key = row.buildingId ?? SHARED_KEY;
    buckets.set(key, (buckets.get(key) ?? ZERO) + toPaise(row.amount));
  }
  return buckets;
}

/* ------------------------------------------------------------------ *
 * The fifteen required scenarios
 * ------------------------------------------------------------------ */

describe('fee engine: the fifteen core scenarios', () => {
  it('1. full monthly payment -> PAID with a zero balance', () => {
    const resident = makeResident({ id: 'r1' });
    const index = buildPaymentIndex([makePayment('r1', '2026-08', 500_000)]);
    const position = monthPosition(resident, '2026-08', index, contextOn('2026-08-20'));

    expect(position.status).toBe('PAID');
    expect(position.expected).toBe(500_000);
    expect(position.paid).toBe(500_000);
    expect(position.balance).toBe(ZERO);
    expect(position.overdue).toBe(false);
    expect(position.daysOverdue).toBe(0);
    expect(position.dueDate).toBe('2026-08-05');
    expect(position.paymentCount).toBe(1);
  });

  it('2. partial monthly payment before the due date -> PART_PAID', () => {
    const resident = makeResident({ id: 'r1' });
    const index = buildPaymentIndex([makePayment('r1', '2026-08', 200_000)]);
    // The 3rd is two days short of the 5th, so nothing is late yet.
    const position = monthPosition(resident, '2026-08', index, contextOn('2026-08-03'));

    expect(position.status).toBe('PART_PAID');
    expect(position.paid).toBe(200_000);
    expect(position.balance).toBe(300_000);
    expect(position.overdue).toBe(false);
    expect(position.daysOverdue).toBe(0);
  });

  it('3. no payment and the due date has not passed -> NOT_DUE', () => {
    const resident = makeResident({ id: 'r1' });
    const position = monthPosition(resident, '2026-08', noPayments(), contextOn('2026-08-03'));

    expect(position.status).toBe('NOT_DUE');
    expect(position.paid).toBe(ZERO);
    expect(position.balance).toBe(500_000);
    expect(position.overdue).toBe(false);
    expect(position.daysOverdue).toBe(0);
    expect(position.paymentCount).toBe(0);
  });

  it('4. no payment and the due date has passed -> OVERDUE with the right daysOverdue', () => {
    const resident = makeResident({ id: 'r1' });
    const position = monthPosition(resident, '2026-08', noPayments(), contextOn('2026-08-20'));

    expect(position.status).toBe('OVERDUE');
    expect(position.overdue).toBe(true);
    expect(position.dueDate).toBe('2026-08-05');
    expect(position.daysOverdue).toBe(15);
    expect(position.balance).toBe(500_000);
  });

  it('5. partial payment after the due date -> OVERDUE, not PART_PAID', () => {
    const resident = makeResident({ id: 'r1' });
    const index = buildPaymentIndex([makePayment('r1', '2026-08', 200_000)]);
    const position = monthPosition(resident, '2026-08', index, contextOn('2026-08-20'));

    expect(position.status).toBe('OVERDUE');
    expect(position.status).not.toBe('PART_PAID');
    expect(position.paid).toBe(200_000);
    expect(position.balance).toBe(300_000);
    expect(position.daysOverdue).toBe(15);
  });

  it('6. months before the resident joined are NOT_STAYING and expect nothing', () => {
    const resident = makeResident({ id: 'r1', joinDate: utc(2026, 5, 10) });
    const context = contextOn('2026-08-20');

    expect(joinMonthOf(resident)).toBe('2026-05');
    expect(isEnrolled(resident, '2026-04')).toBe(false);
    expect(isEnrolled(resident, '2026-05')).toBe(true);

    for (const month of ['2026-03', '2026-04']) {
      const before = monthPosition(resident, month, noPayments(), context);
      expect(before.status).toBe('NOT_STAYING');
      expect(before.expected).toBe(ZERO);
      expect(before.balance).toBe(ZERO);
      expect(before.dueDate).toBeNull();
      expect(before.overdue).toBe(false);
    }

    // The joining month itself is billed in full - there is no proration.
    const joining = monthPosition(resident, '2026-05', noPayments(), context);
    expect(joining.status).toBe('OVERDUE');
    expect(joining.expected).toBe(500_000);

    expect(billableMonths(resident, context)).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
    ]);
  });

  it('7. the vacating month is still billed; months after it are NOT_STAYING', () => {
    const resident = makeResident({
      id: 'r1',
      joinDate: utc(2026, 1, 1),
      vacatedDate: utc(2026, 7, 20),
    });
    const context = contextOn('2026-08-20');

    expect(vacatedMonthOf(resident)).toBe('2026-07');
    expect(isStaying(resident, context)).toBe(false);

    const vacating = monthPosition(resident, '2026-07', noPayments(), context);
    expect(vacating.status).toBe('OVERDUE');
    expect(vacating.expected).toBe(500_000);
    expect(vacating.dueDate).toBe('2026-07-05');

    const after = monthPosition(resident, '2026-08', noPayments(), context);
    expect(after.status).toBe('NOT_STAYING');
    expect(after.expected).toBe(ZERO);
    expect(after.dueDate).toBeNull();

    // Billing stops at the vacating month even though "today" is in August.
    expect(billableMonths(resident, context)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
    ]);
  });

  it('8. a due day of 31 clamps to 28 in February, and to 29 in a leap February', () => {
    const resident = makeResident({ id: 'r1', dueDay: 31 });

    expect(dueDateFor(resident, '2026-02', contextOn('2026-03-01'))).toBe('2026-02-28');
    expect(dueDateFor(resident, '2028-02', contextOn('2028-03-01'))).toBe('2028-02-29');
    expect(dueDateFor(resident, '2026-08', contextOn('2026-08-20'))).toBe('2026-08-31');

    // 2028 is a leap year: the 29th is a real day, so the fee is not late on it.
    const onTheClampedDay = monthPosition(
      resident,
      '2028-02',
      noPayments(),
      contextOn('2028-02-29'),
    );
    expect(onTheClampedDay.dueDate).toBe('2028-02-29');
    expect(onTheClampedDay.status).toBe('NOT_DUE');

    const dayAfter = monthPosition(resident, '2028-02', noPayments(), contextOn('2028-03-01'));
    expect(dayAfter.status).toBe('OVERDUE');
    expect(dayAfter.daysOverdue).toBe(1);

    // 2026 is not a leap year, so the same due day lands on the 28th.
    const nonLeap = monthPosition(resident, '2026-02', noPayments(), contextOn('2026-02-28'));
    expect(nonLeap.dueDate).toBe('2026-02-28');
    expect(nonLeap.status).toBe('NOT_DUE');
  });

  it('9. several payments in one billing month sum and tip PART_PAID into PAID', () => {
    const resident = makeResident({ id: 'r1' });
    const context = contextOn('2026-08-03');

    const firstOnly = monthPosition(
      resident,
      '2026-08',
      buildPaymentIndex([makePayment('r1', '2026-08', 200_000)]),
      context,
    );
    expect(firstOnly.status).toBe('PART_PAID');
    expect(firstOnly.balance).toBe(300_000);

    const both = monthPosition(
      resident,
      '2026-08',
      buildPaymentIndex([
        makePayment('r1', '2026-08', 200_000),
        makePayment('r1', '2026-08', 300_000),
      ]),
      context,
    );
    expect(both.paid).toBe(500_000);
    expect(both.balance).toBe(ZERO);
    expect(both.status).toBe('PAID');
    expect(both.paymentCount).toBe(2);
  });

  it('10. an older unpaid month surfaces in residentArrears with the right oldest month and count', () => {
    const resident = makeResident({ id: 'r1', joinDate: utc(2026, 5, 1) });
    // May settled, June missed entirely, July part paid, August not yet due.
    const index = buildPaymentIndex([
      makePayment('r1', '2026-05', 500_000),
      makePayment('r1', '2026-07', 200_000),
    ]);
    const arrears = residentArrears(resident, index, contextOn('2026-08-03'));

    expect(arrears.residentId).toBe('r1');
    expect(arrears.overdueMonths.map((m) => m.month)).toEqual(['2026-06', '2026-07']);
    expect(
      arrears.overdueMonths.map((m) => ({
        month: m.month,
        balance: m.balance,
        dueDate: m.dueDate,
        daysOverdue: m.daysOverdue,
      })),
    ).toEqual([
      { month: '2026-06', balance: 500_000, dueDate: '2026-06-05', daysOverdue: 59 },
      { month: '2026-07', balance: 300_000, dueDate: '2026-07-05', daysOverdue: 29 },
    ]);

    expect(arrears.oldestUnpaidMonth).toBe('2026-06');
    expect(arrears.totalOverdue).toBe(800_000);
    expect(arrears.maxDaysOverdue).toBe(59);
    // August is unpaid but not yet due: outstanding counts it, overdue does not.
    expect(arrears.outstandingAllMonths).toBe(1_300_000);

    // The DTO is the one place rupees appear.
    expect(toOverdueSummaryDto(arrears)).toEqual({
      totalOverdue: 8000,
      oldestUnpaidMonth: '2026-06',
      numberOfOverdueMonths: 2,
      maxDaysOverdue: 59,
    });
  });

  it('11. a building filter narrows monthTotals to that building only', () => {
    const roster: (FeeResident & { buildingId: string })[] = [
      { ...makeResident({ id: 'r1' }), buildingId: 'b1', monthlyFee: 500_000 },
      { ...makeResident({ id: 'r2' }), buildingId: 'b1', monthlyFee: 400_000 },
      { ...makeResident({ id: 'r3' }), buildingId: 'b2', monthlyFee: 700_000 },
    ];
    const index = buildPaymentIndex([
      makePayment('r1', '2026-08', 500_000),
      makePayment('r3', '2026-08', 700_000),
    ]);
    const context = contextOn('2026-08-20');

    const everyone = monthTotals(roster, '2026-08', index, context);
    expect(everyone.residentCount).toBe(3);
    expect(everyone.expected).toBe(1_600_000);
    expect(everyone.paid).toBe(1_200_000);

    const buildingOne = monthTotals(
      roster.filter((r) => r.buildingId === 'b1'),
      '2026-08',
      index,
      context,
    );
    expect(buildingOne.residentCount).toBe(2);
    expect(buildingOne.expected).toBe(900_000);
    // r3's 700000 belongs to b2 and must not leak into b1's collections.
    expect(buildingOne.paid).toBe(500_000);
    expect(buildingOne.balance).toBe(400_000);

    const buildingTwo = monthTotals(
      roster.filter((r) => r.buildingId === 'b2'),
      '2026-08',
      index,
      context,
    );
    expect(buildingTwo.residentCount).toBe(1);
    expect(buildingTwo.expected).toBe(700_000);
    expect(buildingTwo.paid).toBe(700_000);

    // The parts reconstruct the whole, so no resident is double counted. In
    // integer paise that is an exact identity, not a rounded one.
    expect(buildingOne.expected + buildingTwo.expected).toBe(everyone.expected);
  });

  it('12. a shared (null-building) cost is never attributed to a building, and monthTotals ignores expenses entirely', () => {
    const roster: (FeeResident & { buildingId: string })[] = [
      { ...makeResident({ id: 'r1' }), buildingId: 'b1', monthlyFee: 500_000 },
      { ...makeResident({ id: 'r2' }), buildingId: 'b1', monthlyFee: 400_000 },
    ];
    const index = buildPaymentIndex([makePayment('r1', '2026-08', 500_000)]);
    const context = contextOn('2026-08-20');

    // Bills for the month: one belongs to b1, one was never attributed.
    // 350050 paise is Rs 3,500.50 - the half rupee a float would blur.
    const costs: { buildingId: string | null; amount: Paise }[] = [
      { buildingId: 'b1', amount: 350_050 },
      { buildingId: null, amount: 900_000 },
    ];
    const buckets = bucketCosts(costs);
    expect(buckets.get('b1') ?? ZERO).toBe(350_050);
    expect(buckets.get(SHARED_KEY) ?? ZERO).toBe(900_000);
    // The building column must not swallow the unattributed cost.
    expect(buckets.get('b1') ?? ZERO).not.toBe(1_250_050);

    const totals = monthTotals(roster, '2026-08', index, context);
    // The aggregate is derived purely from fees and payments: the 900000 shared
    // cost and the 350050 building bill appear nowhere in it.
    expect(totals.expected).toBe(900_000); // 500000 + 400000 of rent, not the shared bill
    expect(totals.paid).toBe(500_000);
    expect(totals.balance).toBe(400_000);
    expect(Object.keys(totals).sort()).toEqual(['balance', 'expected', 'paid', 'residentCount']);

    // Adding another shared cost grows only the shared bucket, and cannot move
    // a single resident figure.
    const withMoreShared = bucketCosts([...costs, { buildingId: null, amount: 2_500_000 }]);
    expect(withMoreShared.get(SHARED_KEY) ?? ZERO).toBe(3_400_000);
    expect(withMoreShared.get('b1') ?? ZERO).toBe(350_050);
    const recomputed = monthTotals(roster, '2026-08', index, context);
    expect(recomputed.expected).toBe(totals.expected);
    expect(recomputed.paid).toBe(totals.paid);
  });

  it('13. a partial salary payment -> PART_PAID', () => {
    expect(salaryStatus(1_200_000, 500_000, true)).toBe('PART_PAID');
    // One paisa short of the full salary is still short.
    expect(salaryStatus(1_200_000, 1_199_999, true)).toBe('PART_PAID');
    expect(salaryStatus(1_200_000, 0, true)).toBe('PENDING');
  });

  it('14. salary payments that sum to the full salary -> PAID; an inactive member -> INACTIVE', () => {
    const salary: Paise = 1_200_000;
    const paid = sumPaise([600_000, 400_000, 200_000]);
    expect(paid).toBe(1_200_000);
    expect(salaryStatus(salary, paid, true)).toBe('PAID');
    // Paying more than the salary is still PAID, never an error state.
    expect(salaryStatus(salary, 1_300_000, true)).toBe('PAID');

    // Inactive wins over every other consideration.
    expect(salaryStatus(salary, paid, false)).toBe('INACTIVE');
    expect(salaryStatus(salary, 0, false)).toBe('INACTIVE');

    // A zero salary is not "paid" - the same rule the fee engine applies to a
    // zero monthly fee.
    expect(salaryStatus(0, 0, true)).toBe('PENDING');
  });

  it('15. monthly P&L arithmetic is cash basis: collected - (bills + salaries)', () => {
    const roster: FeeResident[] = [
      makeResident({ id: 'r1' }),
      makeResident({ id: 'r2' }),
      makeResident({ id: 'r3' }),
    ];
    const index = buildPaymentIndex([
      makePayment('r1', '2026-08', 500_000),
      makePayment('r2', '2026-08', 500_000),
      makePayment('r3', '2026-08', 200_000),
    ]);
    const context = contextOn('2026-08-20');

    const totals = monthTotals(roster, '2026-08', index, context);
    const billed = totals.expected;
    const collected = totals.paid;
    const bills = sumPaise([350_050, 120_000]);
    const salaries = sumPaise([800_000, 150_025]);
    const expenses = bills + salaries;

    expect(billed).toBe(1_500_000);
    expect(collected).toBe(1_200_000);
    expect(bills).toBe(470_050);
    expect(salaries).toBe(950_025);
    expect(expenses).toBe(1_420_075);

    // Cash result: what came in, less what went out. Every operand is an
    // integer, so the sub-rupee tails add up exactly.
    expect(collected - expenses).toBe(-220_075);
    // Accrual memo: what was billed, less what went out. Never the headline.
    expect(billed - expenses).toBe(79_925);
    // The two bases genuinely differ here, which is the point of the statement.
    expect(collected).not.toBe(billed);

    // The same statement as the API renders it.
    expect(paiseToRupees(collected - expenses)).toBe(-2200.75);
    expect(paiseToRupees(billed - expenses)).toBe(799.25);
  });
});

/* ------------------------------------------------------------------ *
 * Balance rules
 * ------------------------------------------------------------------ */

describe('balance rules', () => {
  it('an overpayment never creates a negative balance', () => {
    const resident = makeResident({ id: 'r1' });
    const index = buildPaymentIndex([makePayment('r1', '2026-08', 600_000)]);
    const position = monthPosition(resident, '2026-08', index, contextOn('2026-08-20'));

    expect(position.paid).toBe(600_000);
    expect(position.balance).toBe(ZERO);
    expect(position.balance).toBeGreaterThanOrEqual(0);
    expect(position.status).toBe('PAID');
  });

  it('an overpayment does not roll into the next month', () => {
    const resident = makeResident({ id: 'r1' });
    const index = buildPaymentIndex([makePayment('r1', '2026-08', 1_200_000)]);
    const context = contextOn('2026-09-20');

    const august = monthPosition(resident, '2026-08', index, context);
    expect(august.balance).toBe(ZERO);

    const september = monthPosition(resident, '2026-09', index, context);
    expect(september.paid).toBe(ZERO);
    expect(september.balance).toBe(500_000);
    expect(september.status).toBe('OVERDUE');

    // And the credit is invisible to the arrears walk too.
    const arrears = residentArrears(resident, index, context);
    expect(arrears.outstandingAllMonths).toBe(4_000_000); // Jan-Jul + Sep, at 500000
    expect(arrears.overdueMonths.map((m) => m.month)).not.toContain('2026-08');
  });

  it('a zero monthly fee does not report PAID', () => {
    const resident = makeResident({ id: 'r1', monthlyFee: 0 });
    const position = monthPosition(resident, '2026-08', noPayments(), contextOn('2026-08-20'));

    expect(position.expected).toBe(ZERO);
    expect(position.balance).toBe(ZERO);
    expect(position.status).not.toBe('PAID');
    expect(position.status).toBe('NOT_DUE');
    // Nothing is owed, so nothing can be overdue either.
    expect(position.overdue).toBe(false);
    expect(position.daysOverdue).toBe(0);
  });

  it('sums payments as integer paise, so a sub-rupee total is exact', () => {
    // Rs 4,500.56 of rent, settled by Rs 1,200.02 and Rs 3,300.54.
    const resident = makeResident({ id: 'r1', monthlyFee: 450_056 });
    const index = buildPaymentIndex([
      makePayment('r1', '2026-08', 120_002),
      makePayment('r1', '2026-08', 330_054),
    ]);

    // This is the case the integer-paise design exists for. In binary floating
    // point the same two payments land just *below* the fee, which would leave
    // a phantom balance and report a settled month as PART_PAID for ever; as
    // paise they hit it exactly.
    expect(1200.02 + 3300.54).toBeLessThan(4500.56);
    expect(120_002 + 330_054).toBe(450_056);

    const position = monthPosition(resident, '2026-08', index, contextOn('2026-08-20'));
    expect(position.paid).toBe(450_056);
    expect(Number.isInteger(position.paid)).toBe(true);
    expect(position.balance).toBe(ZERO);
    expect(position.status).toBe('PAID');
    // And the rupee figure the API reports is the exact fee, not 4500.5599999.
    expect(paiseToRupees(position.paid)).toBe(4500.56);
  });

  it('keeps a hundred part payments exact, where a float total would drift', () => {
    // A hundred payments of Rs 45.13 - the classic accumulation that pushes a
    // floating-point total off its target by a fraction of a paisa.
    const payments = Array.from({ length: 100 }, () => makePayment('r1', '2026-08', 4_513));
    const resident = makeResident({ id: 'r1', monthlyFee: 451_300 });
    const position = monthPosition(
      resident,
      '2026-08',
      buildPaymentIndex(payments),
      contextOn('2026-08-20'),
    );

    expect(position.paid).toBe(451_300);
    expect(position.balance).toBe(ZERO);
    expect(position.status).toBe('PAID');
    expect(position.paymentCount).toBe(100);
  });
});

/* ------------------------------------------------------------------ *
 * The deliberate overdue refinement
 * ------------------------------------------------------------------ */

describe('the overdue refinement', () => {
  const resident = makeResident({ id: 'r1' });

  it('is NOT overdue on the due date itself', () => {
    const onDueDate = monthPosition(resident, '2026-08', noPayments(), contextOn('2026-08-05'));
    expect(onDueDate.dueDate).toBe('2026-08-05');
    expect(onDueDate.overdue).toBe(false);
    expect(onDueDate.status).toBe('NOT_DUE');
    expect(onDueDate.daysOverdue).toBe(0);
  });

  it('IS overdue the day after the due date, by one day', () => {
    const dayAfter = monthPosition(resident, '2026-08', noPayments(), contextOn('2026-08-06'));
    expect(dayAfter.overdue).toBe(true);
    expect(dayAfter.status).toBe('OVERDUE');
    expect(dayAfter.daysOverdue).toBe(1);
  });

  it('applies the same boundary to a part-paid month', () => {
    const index = buildPaymentIndex([makePayment('r1', '2026-08', 200_000)]);
    expect(monthPosition(resident, '2026-08', index, contextOn('2026-08-05')).status).toBe(
      'PART_PAID',
    );
    expect(monthPosition(resident, '2026-08', index, contextOn('2026-08-06')).status).toBe(
      'OVERDUE',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Payment index
 * ------------------------------------------------------------------ */

describe('buildPaymentIndex', () => {
  it('groups by resident and by billing month', () => {
    const index = buildPaymentIndex([
      makePayment('r1', '2026-08', 200_000),
      makePayment('r1', '2026-08', 300_000),
      makePayment('r1', '2026-09', 500_000),
      makePayment('r2', '2026-08', 400_000),
    ]);

    expect(index.size).toBe(2);
    expect([...(index.get('r1')?.keys() ?? [])].sort()).toEqual(['2026-08', '2026-09']);

    const r1August = index.get('r1')?.get('2026-08');
    expect(r1August?.total ?? ZERO).toBe(500_000);
    expect(r1August?.count).toBe(2);

    const r1September = index.get('r1')?.get('2026-09');
    expect(r1September?.total ?? ZERO).toBe(500_000);
    expect(r1September?.count).toBe(1);

    const r2August = index.get('r2')?.get('2026-08');
    expect(r2August?.total ?? ZERO).toBe(400_000);
    expect(r2August?.count).toBe(1);

    // No cross-contamination between residents or months.
    expect(index.get('r2')?.get('2026-09')).toBeUndefined();
    expect(index.get('r3')).toBeUndefined();
  });

  it('is empty for no payments and reads as zero for an unknown resident', () => {
    const index = buildPaymentIndex([]);
    expect(index.size).toBe(0);

    const position = monthPosition(
      makeResident({ id: 'ghost' }),
      '2026-08',
      index,
      contextOn('2026-08-20'),
    );
    expect(position.paid).toBe(ZERO);
    expect(position.paymentCount).toBe(0);
  });

  it('keys a payment by the month of its billingMonth date, whatever the day', () => {
    const index = buildPaymentIndex([
      { residentId: 'r1', billingMonth: utc(2026, 8, 31), amount: 500_000 },
    ]);
    expect(index.get('r1')?.get('2026-08')?.total ?? ZERO).toBe(500_000);
  });
});

/* ------------------------------------------------------------------ *
 * Year strip
 * ------------------------------------------------------------------ */

describe('yearStrip', () => {
  it('returns exactly twelve entries with the right status in each', () => {
    const resident = makeResident({
      id: 'r1',
      joinDate: utc(2026, 3, 15),
      vacatedDate: utc(2026, 10, 5),
    });
    const index = buildPaymentIndex([
      makePayment('r1', '2026-03', 500_000), // settled
      makePayment('r1', '2026-04', 200_000), // part paid, due date long gone
      makePayment('r1', '2026-06', 500_000),
      makePayment('r1', '2026-07', 500_000),
      makePayment('r1', '2026-08', 300_000), // part paid, due date passed
    ]);
    const strip = yearStrip(resident, 2026, index, contextOn('2026-08-20'));

    expect(strip).toHaveLength(12);
    expect(strip.map((cell) => cell.month)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
    expect(strip.map((cell) => cell.status)).toEqual([
      'NOT_STAYING', // before joining
      'NOT_STAYING',
      'PAID',
      'OVERDUE', // part paid, past due
      'OVERDUE', // nothing paid, past due
      'PAID',
      'PAID',
      'OVERDUE', // part paid, past due
      'NOT_DUE', // due 2026-09-05, still ahead of today
      'NOT_DUE', // vacating month, still billed
      'NOT_STAYING', // after vacating
      'NOT_STAYING',
    ]);
    // The strip is DTO shaped, so its balances are rupees - converted once, at
    // the edge, from the paise the engine worked in.
    expect(strip.map((cell) => cell.balance)).toEqual([
      0, 0, 0, 3000, 5000, 0, 0, 2000, 5000, 5000, 0, 0,
    ]);
  });

  it('is all NOT_STAYING for a year outside the enrolment window', () => {
    const resident = makeResident({ id: 'r1', joinDate: utc(2026, 3, 15) });
    const strip = yearStrip(resident, 2025, noPayments(), contextOn('2026-08-20'));
    expect(strip).toHaveLength(12);
    expect(strip.every((cell) => cell.status === 'NOT_STAYING')).toBe(true);
    expect(strip.every((cell) => cell.balance === 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Supporting helpers
 * ------------------------------------------------------------------ */

describe('enrolment and context helpers', () => {
  it('prefers the resident due day and falls back to the hostel default', () => {
    const context = contextOn('2026-08-20', 10);
    expect(effectiveDueDay(makeResident({ id: 'r1', dueDay: 7 }), context)).toBe(7);
    expect(effectiveDueDay(makeResident({ id: 'r1', dueDay: null }), context)).toBe(10);
    // Nonsense stored in the field falls back rather than producing a bad date.
    expect(effectiveDueDay(makeResident({ id: 'r1', dueDay: 0 }), context)).toBe(10);
    expect(effectiveDueDay(makeResident({ id: 'r1', dueDay: 45 }), context)).toBe(10);
    expect(dueDateFor(makeResident({ id: 'r1', dueDay: null }), '2026-08', context)).toBe(
      '2026-08-10',
    );
  });

  it('treats a resident vacating this month as still staying', () => {
    const context = contextOn('2026-08-20');
    expect(isStaying(makeResident({ id: 'r1', vacatedDate: null }), context)).toBe(true);
    expect(isStaying(makeResident({ id: 'r1', vacatedDate: utc(2026, 8, 31) }), context)).toBe(true);
    expect(isStaying(makeResident({ id: 'r1', vacatedDate: utc(2026, 7, 31) }), context)).toBe(
      false,
    );
  });

  it('bounds billableMonths by an explicit upToMonth', () => {
    const resident = makeResident({ id: 'r1', joinDate: utc(2026, 5, 1) });
    expect(billableMonths(resident, contextOn('2026-08-20'), '2026-06')).toEqual([
      '2026-05',
      '2026-06',
    ]);
  });

  it('finds the earliest joining month across a roster', () => {
    expect(
      earliestJoinMonth([
        makeResident({ id: 'r1', joinDate: utc(2026, 5, 1) }),
        makeResident({ id: 'r2', joinDate: utc(2024, 11, 30) }),
        makeResident({ id: 'r3', joinDate: utc(2025, 1, 1) }),
      ]),
    ).toBe('2024-11');
    expect(earliestJoinMonth([])).toBeNull();
  });

  it('sums cash received regardless of which month each payment settles', () => {
    // Three payments banked in September: one for September, two catching up.
    const received = cashReceivedIn([
      makePayment('r1', '2026-09', 500_000),
      makePayment('r1', '2026-07', 300_000),
      makePayment('r2', '2026-08', 250_050),
    ]);
    expect(received).toBe(1_050_050);
    expect(paiseToRupees(received)).toBe(10500.5);
    expect(cashReceivedIn([])).toBe(ZERO);
  });

  it('builds a context from settings and a fixed instant, in the hostel timezone', () => {
    // 19:30Z on the 15th is already the 16th in Kolkata.
    const context = createFeeContext(
      { defaultDueDay: 10, timezone: 'Asia/Kolkata' },
      new Date('2026-08-15T19:30:00Z'),
    );
    expect(context.today).toBe('2026-08-16');
    expect(context.currentMonth).toBe('2026-08');
    expect(context.defaultDueDay).toBe(10);

    const utcContext = createFeeContext(
      { defaultDueDay: 10, timezone: 'UTC' },
      new Date('2026-08-15T19:30:00Z'),
    );
    expect(utcContext.today).toBe('2026-08-15');
  });

  it('converts a position to the DTO the API returns, in rupees', () => {
    const resident = makeResident({ id: 'r1' });
    const index = buildPaymentIndex([makePayment('r1', '2026-08', 200_000)]);
    const dto = toMonthFeeStatusDto(
      monthPosition(resident, '2026-08', index, contextOn('2026-08-20')),
    );

    // Paise in, rupees out - the conversion happens exactly here and nowhere
    // deeper in the engine.
    expect(dto).toEqual({
      month: '2026-08',
      expected: 5000,
      paid: 2000,
      balance: 3000,
      status: 'OVERDUE',
      dueDate: '2026-08-05',
      daysOverdue: 15,
      paymentCount: 1,
    });
    expect(typeof dto.balance).toBe('number');
  });

  it('renders a sub-rupee position without losing the paise', () => {
    const resident = makeResident({ id: 'r1', monthlyFee: 450_056 });
    const index = buildPaymentIndex([makePayment('r1', '2026-08', 120_002)]);
    const dto = toMonthFeeStatusDto(
      monthPosition(resident, '2026-08', index, contextOn('2026-08-20')),
    );

    expect(dto.expected).toBe(4500.56);
    expect(dto.paid).toBe(1200.02);
    expect(dto.balance).toBe(3300.54);
    // The three rupee figures still reconcile after the conversion.
    expect(Number((dto.paid + dto.balance).toFixed(2))).toBe(dto.expected);
  });
});
