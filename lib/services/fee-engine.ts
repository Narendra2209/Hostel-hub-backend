/**
 * The fee engine.
 *
 * This is the single authoritative implementation of the hostel's financial
 * rules. Every balance, status, overdue figure and dashboard total in the system
 * is produced here, from ledger rows. Nothing is cached in a field that could
 * drift; nothing is recomputed in the browser.
 *
 * Rules
 * -----
 *  * A resident owes `monthlyFee` for every billing month from their joining
 *    month through their vacating month (inclusive). Months outside that window
 *    are NOT_STAYING and carry no expectation.
 *  * The due date is the resident's own due day, falling back to the hostel
 *    default, clamped to the last valid day of the month (day 31 becomes 28/29
 *    in February).
 *  * `balance = max(0, monthlyFee - sum(payments allocated to that month))`.
 *    Several payments may target one month; an overpayment does not roll over.
 *  * A month is overdue once its due date is behind us in the hostel's
 *    timezone. See `isPastDueDate` for the one deliberate difference from the
 *    reference implementation.
 *
 * All arithmetic is in integer paise (see lib/db/money.ts), so totals are exact.
 * Rupees appear only in the DTO, at the very edge.
 */
import type {
  MonthFeeStatusDto,
  MonthKey,
  OverdueSummaryDto,
  PaymentStatus,
} from '@hostel/shared';
import {
  currentMonthKey,
  dueDateForMonth,
  daysOverdue as daysLate,
  isPastDueDate,
  monthRange,
  todayIso,
  utcDateToMonthKey,
} from '@hostel/shared';
import { balanceOf, paiseToRupees, sumPaise, toPaise, ZERO, type Paise } from '../db/money';

/** The minimum a record needs to look like for the engine to bill it. */
export interface FeeResident {
  id: string;
  /** Monthly rent, in paise. */
  monthlyFee: number;
  dueDay: number | null;
  joinDate: Date;
  vacatedDate: Date | null;
}

/** A payment as the engine needs it. */
export interface FeePaymentRow {
  residentId: string;
  billingMonth: Date;
  /** Amount, in paise. */
  amount: number;
}

/** residentId -> monthKey -> { total, count } */
export type PaymentIndex = Map<string, Map<MonthKey, { total: Paise; count: number }>>;

/** Evaluation context: "now" and the hostel's default due day, resolved once. */
export interface FeeContext {
  today: string;
  currentMonth: MonthKey;
  defaultDueDay: number;
  timezone: string;
}

export function createFeeContext(
  settings: { defaultDueDay: number; timezone: string },
  now: Date = new Date(),
): FeeContext {
  const today = todayIso(settings.timezone, now);
  return {
    today,
    currentMonth: today.slice(0, 7),
    defaultDueDay: settings.defaultDueDay,
    timezone: settings.timezone,
  };
}

/* ------------------------------------------------------------------ *
 * Enrolment window
 * ------------------------------------------------------------------ */

export const joinMonthOf = (resident: FeeResident): MonthKey =>
  utcDateToMonthKey(resident.joinDate);

export const vacatedMonthOf = (resident: FeeResident): MonthKey | null =>
  resident.vacatedDate ? utcDateToMonthKey(resident.vacatedDate) : null;

/** Was the resident staying during this billing month? */
export function isEnrolled(resident: FeeResident, month: MonthKey): boolean {
  const join = joinMonthOf(resident);
  if (month < join) return false;
  const vacated = vacatedMonthOf(resident);
  return !vacated || month <= vacated;
}

/** Is the resident still staying as of the context's current month? */
export function isStaying(resident: FeeResident, context: FeeContext): boolean {
  const vacated = vacatedMonthOf(resident);
  return !vacated || vacated >= context.currentMonth;
}

export const effectiveDueDay = (resident: FeeResident, context: FeeContext): number =>
  resident.dueDay && resident.dueDay >= 1 && resident.dueDay <= 31
    ? resident.dueDay
    : context.defaultDueDay;

/** The due date for one billing month, clamped to a day that exists. */
export const dueDateFor = (resident: FeeResident, month: MonthKey, context: FeeContext): string =>
  dueDateForMonth(month, effectiveDueDay(resident, context));

/**
 * Every billing month the resident can be charged for, up to `upToMonth`
 * (defaults to the current month). Bounded by their vacating month.
 */
export function billableMonths(
  resident: FeeResident,
  context: FeeContext,
  upToMonth: MonthKey = context.currentMonth,
): MonthKey[] {
  const join = joinMonthOf(resident);
  const vacated = vacatedMonthOf(resident);
  const end = vacated && vacated < upToMonth ? vacated : upToMonth;
  return monthRange(join, end);
}

/* ------------------------------------------------------------------ *
 * Payment index
 * ------------------------------------------------------------------ */

/**
 * Fold a flat list of payments into residentId -> month -> total.
 * Built once per request so no code path ever issues one query per resident.
 */
export function buildPaymentIndex(payments: FeePaymentRow[]): PaymentIndex {
  const index: PaymentIndex = new Map();
  for (const payment of payments) {
    const month = utcDateToMonthKey(payment.billingMonth);
    let byMonth = index.get(payment.residentId);
    if (!byMonth) {
      byMonth = new Map();
      index.set(payment.residentId, byMonth);
    }
    const existing = byMonth.get(month);
    if (existing) {
      existing.total += toPaise(payment.amount);
      existing.count += 1;
    } else {
      byMonth.set(month, { total: toPaise(payment.amount), count: 1 });
    }
  }
  return index;
}

const lookup = (
  index: PaymentIndex,
  residentId: string,
  month: MonthKey,
): { total: Paise; count: number } => index.get(residentId)?.get(month) ?? { total: ZERO, count: 0 };

/* ------------------------------------------------------------------ *
 * Status for one month
 * ------------------------------------------------------------------ */

export interface MonthFeePosition {
  month: MonthKey;
  /** Every amount below is in paise. */
  expected: Paise;
  paid: Paise;
  balance: Paise;
  status: PaymentStatus;
  dueDate: string | null;
  daysOverdue: number;
  paymentCount: number;
  overdue: boolean;
}

/**
 * The fee position for one resident in one billing month.
 *
 * Status precedence mirrors the reference implementation exactly:
 *   not staying -> NOT_STAYING
 *   settled and something was billed -> PAID
 *   part paid -> OVERDUE if the due date passed, else PART_PAID
 *   nothing paid -> OVERDUE if the due date passed, else NOT_DUE
 */
export function monthPosition(
  resident: FeeResident,
  month: MonthKey,
  index: PaymentIndex,
  context: FeeContext,
): MonthFeePosition {
  if (!isEnrolled(resident, month)) {
    return {
      month,
      expected: ZERO,
      paid: ZERO,
      balance: ZERO,
      status: 'NOT_STAYING',
      dueDate: null,
      daysOverdue: 0,
      paymentCount: 0,
      overdue: false,
    };
  }

  const expected = toPaise(resident.monthlyFee);
  const { total: paid, count } = lookup(index, resident.id, month);
  const balance = balanceOf(expected, paid);
  const dueDate = dueDateFor(resident, month, context);
  const past = isPastDueDate(dueDate, context.today);
  const overdue = balance > 0 && past;

  let status: PaymentStatus;
  if (balance === 0 && expected > 0) {
    status = 'PAID';
  } else if (paid > 0) {
    status = overdue ? 'OVERDUE' : 'PART_PAID';
  } else {
    status = overdue ? 'OVERDUE' : 'NOT_DUE';
  }

  return {
    month,
    expected,
    paid,
    balance,
    status,
    dueDate,
    daysOverdue: overdue ? daysLate(dueDate, context.today) : 0,
    paymentCount: count,
    overdue,
  };
}

export const toMonthFeeStatusDto = (position: MonthFeePosition): MonthFeeStatusDto => ({
  month: position.month,
  expected: paiseToRupees(position.expected),
  paid: paiseToRupees(position.paid),
  balance: paiseToRupees(position.balance),
  status: position.status,
  dueDate: position.dueDate,
  daysOverdue: position.daysOverdue,
  paymentCount: position.paymentCount,
});

/* ------------------------------------------------------------------ *
 * Arrears across every month
 * ------------------------------------------------------------------ */

export interface OverdueMonth {
  residentId: string;
  month: MonthKey;
  expected: Paise;
  paid: Paise;
  balance: Paise;
  dueDate: string;
  daysOverdue: number;
}

export interface ResidentArrears {
  residentId: string;
  overdueMonths: OverdueMonth[];
  totalOverdue: Paise;
  oldestUnpaidMonth: MonthKey | null;
  maxDaysOverdue: number;
  /** Balance across every billable month, whether or not the due date passed. */
  outstandingAllMonths: Paise;
}

/**
 * Walk every billing month the resident has been charged for and collect the
 * ones still owing past their due date.
 *
 * Cost is O(residents x months), all in memory, over data already fetched by
 * two queries - never a query per resident.
 */
export function residentArrears(
  resident: FeeResident,
  index: PaymentIndex,
  context: FeeContext,
  upToMonth: MonthKey = context.currentMonth,
): ResidentArrears {
  const overdueMonths: OverdueMonth[] = [];
  let totalOverdue: Paise = ZERO;
  let outstandingAllMonths: Paise = ZERO;
  let maxDaysOverdue = 0;

  for (const month of billableMonths(resident, context, upToMonth)) {
    const position = monthPosition(resident, month, index, context);
    if (position.balance === 0) continue;

    outstandingAllMonths += position.balance;

    if (position.overdue && position.dueDate) {
      overdueMonths.push({
        residentId: resident.id,
        month,
        expected: position.expected,
        paid: position.paid,
        balance: position.balance,
        dueDate: position.dueDate,
        daysOverdue: position.daysOverdue,
      });
      totalOverdue += position.balance;
      if (position.daysOverdue > maxDaysOverdue) maxDaysOverdue = position.daysOverdue;
    }
  }

  return {
    residentId: resident.id,
    overdueMonths,
    totalOverdue,
    // billableMonths is chronological, so the first overdue entry is the oldest.
    oldestUnpaidMonth: overdueMonths.length ? overdueMonths[0]!.month : null,
    maxDaysOverdue,
    outstandingAllMonths,
  };
}

export const toOverdueSummaryDto = (arrears: ResidentArrears): OverdueSummaryDto => ({
  totalOverdue: paiseToRupees(arrears.totalOverdue),
  oldestUnpaidMonth: arrears.oldestUnpaidMonth,
  numberOfOverdueMonths: arrears.overdueMonths.length,
  maxDaysOverdue: arrears.maxDaysOverdue,
});

/* ------------------------------------------------------------------ *
 * Aggregates
 * ------------------------------------------------------------------ */

export interface MonthTotals {
  residentCount: number;
  /** Every amount below is in paise. */
  expected: Paise;
  paid: Paise;
  balance: Paise;
}

/**
 * Billed / collected / outstanding for a set of residents in one month.
 * Only residents enrolled that month contribute.
 */
export function monthTotals(
  residents: FeeResident[],
  month: MonthKey,
  index: PaymentIndex,
  context: FeeContext,
): MonthTotals {
  let expected: Paise = ZERO;
  let paid: Paise = ZERO;
  let residentCount = 0;

  for (const resident of residents) {
    if (!isEnrolled(resident, month)) continue;
    residentCount += 1;
    const position = monthPosition(resident, month, index, context);
    expected += position.expected;
    paid += position.paid;
  }

  return { residentCount, expected, paid, balance: balanceOf(expected, paid) };
}

/**
 * Cash actually received in a month, regardless of which month it settles.
 * This is the revenue line of the cash-basis P&L, and it is deliberately NOT
 * the same as `monthTotals().paid`, which is money allocated *to* a month.
 */
export function cashReceivedIn(payments: FeePaymentRow[]): Paise {
  return sumPaise(payments.map((payment) => payment.amount));
}

/** The Jan-Dec strip for one resident. */
export function yearStrip(
  resident: FeeResident,
  year: number,
  index: PaymentIndex,
  context: FeeContext,
): { month: MonthKey; status: PaymentStatus; balance: number }[] {
  return Array.from({ length: 12 }, (_, i) => {
    const month = `${year}-${String(i + 1).padStart(2, '0')}`;
    const position = monthPosition(resident, month, index, context);
    return {
      month,
      status: position.status,
      balance: paiseToRupees(position.balance),
    };
  });
}

/** Earliest joining month across a roster - the lower bound for a payments query. */
export function earliestJoinMonth(residents: FeeResident[]): MonthKey | null {
  let earliest: MonthKey | null = null;
  for (const resident of residents) {
    const month = joinMonthOf(resident);
    if (!earliest || month < earliest) earliest = month;
  }
  return earliest;
}

/** Convenience for tests and scripts that do not have settings loaded. */
export const defaultContext = (now: Date = new Date()): FeeContext => ({
  today: todayIso(undefined, now),
  currentMonth: currentMonthKey(undefined, now),
  defaultDueDay: 5,
  timezone: 'Asia/Kolkata',
});
