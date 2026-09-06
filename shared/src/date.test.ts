/**
 * Date utility unit tests.
 *
 * Billing months and calendar dates are business facts carried as strings; a
 * Date object only ever appears at the PostgreSQL boundary, pinned to UTC
 * midnight. These tests hold that line: every conversion round-trips, every
 * "today" is resolved in Asia/Kolkata rather than the server's incidental
 * locale, and no test reads the real clock.
 */
import { describe, expect, it } from 'vitest';
import {
  assertIsoDate,
  assertMonthKey,
  currentMonthKey,
  daysBetween,
  daysInMonth,
  daysOverdue,
  dueDateForMonth,
  firstDayOfMonth,
  isIsoDate,
  isMonthKey,
  isPastDueDate,
  isoDateToUtcDate,
  lastDayOfMonth,
  monthDifference,
  monthKeyOfIsoDate,
  monthKeyToUtcDate,
  monthRange,
  monthsOfYear,
  nextMonthKey,
  previousMonthKey,
  todayIso,
  utcDateToIsoDate,
  utcDateToMonthKey,
} from './date.js';

describe('validators', () => {
  it('accepts well-formed keys and rejects malformed ones', () => {
    expect(isMonthKey('2026-08')).toBe(true);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('2026-8')).toBe(false);
    expect(isMonthKey('2026-08-01')).toBe(false);
    expect(isMonthKey(202608)).toBe(false);

    expect(isIsoDate('2026-08-15')).toBe(true);
    expect(isIsoDate('2026-08-32')).toBe(false);
    expect(isIsoDate('2026-00-15')).toBe(false);
    expect(isIsoDate('2026-08')).toBe(false);
  });

  it('throws RangeError on invalid input rather than producing a silent bad date', () => {
    expect(() => assertMonthKey('2026-13')).toThrow(RangeError);
    expect(() => assertIsoDate('not-a-date')).toThrow(RangeError);
    expect(assertMonthKey('2026-08')).toBe('2026-08');
    expect(assertIsoDate('2026-08-15')).toBe('2026-08-15');
  });

  it('extracts the month of an ISO date', () => {
    expect(monthKeyOfIsoDate('2026-08-15')).toBe('2026-08');
    expect(firstDayOfMonth('2026-08')).toBe('2026-08-01');
  });
});

describe('month arithmetic', () => {
  it('steps forward across a year boundary', () => {
    expect(nextMonthKey('2026-11')).toBe('2026-12');
    expect(nextMonthKey('2026-12')).toBe('2027-01');
    expect(nextMonthKey('2026-12', 2)).toBe('2027-02');
    expect(nextMonthKey('2026-01', 23)).toBe('2027-12');
  });

  it('steps backward across a year boundary', () => {
    expect(previousMonthKey('2026-01')).toBe('2025-12');
    expect(previousMonthKey('2026-02', 3)).toBe('2025-11');
    expect(nextMonthKey('2026-01', -13)).toBe('2024-12');
  });

  it('is the identity for a zero step', () => {
    expect(nextMonthKey('2026-08', 0)).toBe('2026-08');
  });

  it('measures a signed month difference across years', () => {
    expect(monthDifference('2026-01', '2026-08')).toBe(7);
    expect(monthDifference('2025-11', '2026-02')).toBe(3);
    expect(monthDifference('2026-08', '2026-01')).toBe(-7);
    expect(monthDifference('2026-08', '2026-08')).toBe(0);
  });

  it('lists the twelve months of a year', () => {
    const year = monthsOfYear(2026);
    expect(year).toHaveLength(12);
    expect(year[0]).toBe('2026-01');
    expect(year[11]).toBe('2026-12');
  });
});

describe('monthRange', () => {
  it('is inclusive of both ends', () => {
    expect(monthRange('2026-06', '2026-09')).toEqual([
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    expect(monthRange('2026-08', '2026-08')).toEqual(['2026-08']);
  });

  it('crosses a year boundary', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  it('returns [] when the start is after the end', () => {
    expect(monthRange('2026-09', '2026-06')).toEqual([]);
  });

  it('returns [] for a malformed bound instead of looping', () => {
    expect(monthRange('2026-13', '2026-06')).toEqual([]);
    expect(monthRange('2026-06', 'nope')).toEqual([]);
  });

  it('honours the maxMonths cap so a corrupt join date cannot spin a Lambda', () => {
    expect(monthRange('2026-01', '2026-12', 3)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(monthRange('2026-01', '2026-12', 1)).toEqual(['2026-01']);
    // The default cap is 1200 months; a millennium-wide span is truncated, not endless.
    expect(monthRange('1900-01', '2999-12')).toHaveLength(1200);
  });
});

describe('daysInMonth / lastDayOfMonth', () => {
  it('knows the length of every month shape', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('handles February, including leap and century rules', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
  });

  it('derives the last calendar day of a billing month', () => {
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
    expect(lastDayOfMonth('2026-04')).toBe('2026-04-30');
    expect(lastDayOfMonth('2026-12')).toBe('2026-12-31');
  });
});

describe('dueDateForMonth', () => {
  it('uses the configured day when it exists in the month', () => {
    expect(dueDateForMonth('2026-08', 5)).toBe('2026-08-05');
    expect(dueDateForMonth('2026-08', 31)).toBe('2026-08-31');
    expect(dueDateForMonth('2026-08', 1)).toBe('2026-08-01');
  });

  it('clamps a day 31 to the last day of a shorter month', () => {
    expect(dueDateForMonth('2026-02', 31)).toBe('2026-02-28');
    expect(dueDateForMonth('2028-02', 31)).toBe('2028-02-29');
    expect(dueDateForMonth('2026-04', 31)).toBe('2026-04-30');
    expect(dueDateForMonth('2026-02', 30)).toBe('2026-02-28');
  });

  it('clamps a nonsensical day up to the first of the month', () => {
    expect(dueDateForMonth('2026-08', 0)).toBe('2026-08-01');
    expect(dueDateForMonth('2026-08', -5)).toBe('2026-08-01');
    expect(dueDateForMonth('2026-08', 5.9)).toBe('2026-08-05');
  });
});

describe('daysBetween', () => {
  it('counts whole days within a month', () => {
    expect(daysBetween('2026-08-05', '2026-08-20')).toBe(15);
    expect(daysBetween('2026-08-05', '2026-08-05')).toBe(0);
  });

  it('is signed', () => {
    expect(daysBetween('2026-08-20', '2026-08-05')).toBe(-15);
  });

  it('crosses months, years and a leap day without losing a day to an offset', () => {
    expect(daysBetween('2026-06-05', '2026-08-03')).toBe(59);
    expect(daysBetween('2025-12-25', '2026-01-05')).toBe(11);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365);
  });
});

describe('isPastDueDate / daysOverdue', () => {
  it('is NOT overdue on the due date itself (the deliberate refinement)', () => {
    // The reference implementation marked a fee overdue from 00:00 on the due
    // day. Here the due date itself must be behind us.
    expect(isPastDueDate('2026-08-05', '2026-08-05')).toBe(false);
    expect(daysOverdue('2026-08-05', '2026-08-05')).toBe(0);
  });

  it('IS overdue the day after, by exactly one day', () => {
    expect(isPastDueDate('2026-08-05', '2026-08-06')).toBe(true);
    expect(daysOverdue('2026-08-05', '2026-08-06')).toBe(1);
  });

  it('is not overdue before the due date', () => {
    expect(isPastDueDate('2026-08-05', '2026-08-04')).toBe(false);
    expect(daysOverdue('2026-08-05', '2026-08-04')).toBe(0);
  });

  it('counts days late across months and years', () => {
    expect(daysOverdue('2026-06-05', '2026-08-03')).toBe(59);
    expect(daysOverdue('2025-12-05', '2026-01-05')).toBe(31);
  });
});

describe('database boundary round-trips', () => {
  it('pins an ISO date to UTC midnight and back', () => {
    const date = isoDateToUtcDate('2026-08-15');
    expect(date.toISOString()).toBe('2026-08-15T00:00:00.000Z');
    expect(utcDateToIsoDate(date)).toBe('2026-08-15');
  });

  it('pins a month key to the first of the month at UTC midnight and back', () => {
    const date = monthKeyToUtcDate('2026-08');
    expect(date.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(utcDateToMonthKey(date)).toBe('2026-08');
  });

  it('round-trips every day of a leap year without drifting a day', () => {
    for (const month of monthsOfYear(2028)) {
      const days = daysInMonth(2028, Number(month.slice(5, 7)));
      for (let day = 1; day <= days; day++) {
        const iso = `${month}-${String(day).padStart(2, '0')}`;
        expect(utcDateToIsoDate(isoDateToUtcDate(iso))).toBe(iso);
      }
      expect(utcDateToMonthKey(monthKeyToUtcDate(month))).toBe(month);
    }
  });

  it('reads a Date with UTC getters, so a late-evening instant keeps its date', () => {
    expect(utcDateToIsoDate(new Date('2026-08-15T23:59:59.999Z'))).toBe('2026-08-15');
    expect(utcDateToMonthKey(new Date('2026-08-31T23:59:59.999Z'))).toBe('2026-08');
  });
});

describe('todayIso / currentMonthKey resolve in Asia/Kolkata', () => {
  // 19:30Z is 01:00 IST the next day: the two calendars genuinely disagree.
  const eveningInUtc = new Date('2026-08-15T19:30:00Z');

  it('returns the Kolkata date, not the UTC one', () => {
    expect(todayIso('UTC', eveningInUtc)).toBe('2026-08-15');
    expect(todayIso('Asia/Kolkata', eveningInUtc)).toBe('2026-08-16');
  });

  it('defaults to the hostel timezone when none is given', () => {
    expect(todayIso(undefined, eveningInUtc)).toBe('2026-08-16');
  });

  it('agrees with UTC when the instant is nowhere near the boundary', () => {
    const midday = new Date('2026-08-15T06:00:00Z');
    expect(todayIso('UTC', midday)).toBe('2026-08-15');
    expect(todayIso('Asia/Kolkata', midday)).toBe('2026-08-15');
  });

  it('rolls the billing month over on the Kolkata calendar, not the UTC one', () => {
    const lastEveningOfAugust = new Date('2026-08-31T19:30:00Z');
    expect(currentMonthKey('UTC', lastEveningOfAugust)).toBe('2026-08');
    expect(currentMonthKey('Asia/Kolkata', lastEveningOfAugust)).toBe('2026-09');
  });

  it('rolls the year over on the Kolkata calendar too', () => {
    const newYearsEve = new Date('2025-12-31T19:30:00Z');
    expect(todayIso('Asia/Kolkata', newYearsEve)).toBe('2026-01-01');
    expect(currentMonthKey('Asia/Kolkata', newYearsEve)).toBe('2026-01');
    expect(currentMonthKey('UTC', newYearsEve)).toBe('2025-12');
  });
});
