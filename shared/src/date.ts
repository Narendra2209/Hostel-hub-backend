/**
 * Timezone-safe date utilities.
 *
 * The rule for this codebase: a *billing month* and a *calendar date* are
 * business facts, not instants in time. They are represented as plain strings
 * ("2026-08" / "2026-08-15") everywhere in the API and only converted to a
 * `Date` at the PostgreSQL boundary, where they are pinned to UTC midnight so
 * Prisma's `@db.Date` round-trips without ever shifting a day.
 *
 * "Today" is always resolved in Asia/Kolkata (see APP_TIMEZONE), never from the
 * server's incidental locale, so a Lambda running in us-east-1 agrees with the
 * hostel owner standing in the corridor.
 */
import { APP_TIMEZONE } from './constants.js';

/** "2026-08" */
export type MonthKey = string;
/** "2026-08-15" */
export type IsoDate = string;

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const isMonthKey = (value: unknown): value is MonthKey =>
  typeof value === 'string' && MONTH_KEY_RE.test(value);

export const isIsoDate = (value: unknown): value is IsoDate =>
  typeof value === 'string' && ISO_DATE_RE.test(value);

export function assertMonthKey(value: string): MonthKey {
  if (!isMonthKey(value)) throw new RangeError(`Invalid month key: ${value}`);
  return value;
}

export function assertIsoDate(value: string): IsoDate {
  if (!isIsoDate(value)) throw new RangeError(`Invalid ISO date: ${value}`);
  return value;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Splits "2026-08" into numeric parts. */
export function parseMonthKey(mk: MonthKey): { year: number; month: number } {
  assertMonthKey(mk);
  return { year: Number(mk.slice(0, 4)), month: Number(mk.slice(5, 7)) };
}

/** Splits "2026-08-15" into numeric parts. */
export function parseIsoDate(iso: IsoDate): { year: number; month: number; day: number } {
  assertIsoDate(iso);
  return {
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
  };
}

export const monthKey = (year: number, month: number): MonthKey => `${year}-${pad2(month)}`;

export const isoDate = (year: number, month: number, day: number): IsoDate =>
  `${year}-${pad2(month)}-${pad2(day)}`;

/** Number of days in a month. `month` is 1-12. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The `YYYY-MM` a `YYYY-MM-DD` belongs to. */
export const monthKeyOfIsoDate = (iso: IsoDate): MonthKey => assertIsoDate(iso).slice(0, 7);

/** "today" as a plain ISO date in the hostel's timezone. */
export function todayIso(timeZone: string = APP_TIMEZONE, now: Date = new Date()): IsoDate {
  // 'en-CA' formats as YYYY-MM-DD, which is exactly the shape we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** "this month" as a plain month key in the hostel's timezone. */
export const currentMonthKey = (
  timeZone: string = APP_TIMEZONE,
  now: Date = new Date(),
): MonthKey => todayIso(timeZone, now).slice(0, 7);

/* ------------------------------------------------------------------ *
 * Database boundary: plain strings <-> UTC-midnight Date objects.
 * Prisma `@db.Date` columns are read/written at UTC midnight, so these are the
 * ONLY functions that construct a Date from business data.
 * ------------------------------------------------------------------ */

/** "2026-08-15" -> Date at 2026-08-15T00:00:00.000Z */
export function isoDateToUtcDate(iso: IsoDate): Date {
  const { year, month, day } = parseIsoDate(iso);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

/** Date -> "2026-08-15", read with UTC getters so no timezone can shift it. */
export function utcDateToIsoDate(date: Date): IsoDate {
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** "2026-08" -> Date at 2026-08-01T00:00:00.000Z (the canonical billingMonth value). */
export function monthKeyToUtcDate(mk: MonthKey): Date {
  const { year, month } = parseMonthKey(mk);
  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
}

/** Date -> "2026-08". */
export function utcDateToMonthKey(date: Date): MonthKey {
  return monthKey(date.getUTCFullYear(), date.getUTCMonth() + 1);
}

/** First calendar day of a billing month, as an ISO date. */
export const firstDayOfMonth = (mk: MonthKey): IsoDate => `${assertMonthKey(mk)}-01`;

/** Last calendar day of a billing month, as an ISO date. */
export function lastDayOfMonth(mk: MonthKey): IsoDate {
  const { year, month } = parseMonthKey(mk);
  return isoDate(year, month, daysInMonth(year, month));
}

/** Shift a month key by `step` months. */
export function nextMonthKey(mk: MonthKey, step = 1): MonthKey {
  const { year, month } = parseMonthKey(mk);
  const zeroBased = year * 12 + (month - 1) + step;
  return monthKey(Math.floor(zeroBased / 12), (zeroBased % 12) + 1);
}

export const previousMonthKey = (mk: MonthKey, step = 1): MonthKey => nextMonthKey(mk, -step);

/** Signed count of months from `a` to `b`. */
export function monthDifference(a: MonthKey, b: MonthKey): number {
  const from = parseMonthKey(a);
  const to = parseMonthKey(b);
  return (to.year - from.year) * 12 + (to.month - from.month);
}

/**
 * Inclusive list of month keys from `start` to `end`.
 * Returns [] when start is after end, and is hard-capped so a corrupt join date
 * can never spin a Lambda for a thousand years.
 */
export function monthRange(start: MonthKey, end: MonthKey, maxMonths = 1200): MonthKey[] {
  if (!isMonthKey(start) || !isMonthKey(end)) return [];
  const span = monthDifference(start, end);
  if (span < 0) return [];
  const count = Math.min(span, maxMonths - 1);
  const out: MonthKey[] = [];
  for (let i = 0; i <= count; i++) out.push(nextMonthKey(start, i));
  return out;
}

/** The twelve month keys of a calendar year. */
export const monthsOfYear = (year: number): MonthKey[] =>
  Array.from({ length: 12 }, (_, i) => monthKey(year, i + 1));

/**
 * The date rent is due for a given billing month.
 * The configured due day is clamped to the last valid day of the month, so a
 * due day of 31 becomes 28 (or 29) in February.
 */
export function dueDateForMonth(mk: MonthKey, dueDay: number): IsoDate {
  const { year, month } = parseMonthKey(mk);
  const clamped = Math.min(Math.max(Math.trunc(dueDay) || 1, 1), daysInMonth(year, month));
  return isoDate(year, month, clamped);
}

/**
 * Whole days between two ISO dates (b - a). Both are read at UTC midnight so
 * daylight-saving and timezone offsets cannot produce a fractional day.
 */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((isoDateToUtcDate(b).getTime() - isoDateToUtcDate(a).getTime()) / 86_400_000);
}

/**
 * Has the due date passed?
 *
 * Deliberate refinement of the reference implementation: the original marked a
 * fee overdue from 00:00 *on* the due day. A fee is only overdue once the due
 * date itself is behind us, evaluated in the hostel's timezone.
 */
export const isPastDueDate = (dueDate: IsoDate, today: IsoDate): boolean => today > dueDate;

/** How many days late; 0 when not yet overdue. */
export const daysOverdue = (dueDate: IsoDate, today: IsoDate): number =>
  isPastDueDate(dueDate, today) ? daysBetween(dueDate, today) : 0;

/* ------------------------------------------------------------------ *
 * Display helpers (used by the web client).
 * ------------------------------------------------------------------ */

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export const MONTH_SHORT_LABELS: readonly string[] = MONTH_LABELS;

const EM_DASH = '—';

/** "2026-08" -> "Aug 2026" (matches the reference UI). */
export function formatMonthLabel(mk: MonthKey): string {
  if (!isMonthKey(mk)) return EM_DASH;
  const { year, month } = parseMonthKey(mk);
  return `${MONTH_LABELS[month - 1]} ${year}`;
}

/** "2026-08-15" -> "15 Aug 2026". */
export function formatDateLabel(iso: IsoDate): string {
  if (!isIsoDate(iso)) return EM_DASH;
  const { year, month, day } = parseIsoDate(iso);
  return `${day} ${MONTH_LABELS[month - 1]} ${year}`;
}

/** "2026-08-15" -> "15 Aug" (compact, used inside table cells). */
export function formatDayMonthLabel(iso: IsoDate): string {
  if (!isIsoDate(iso)) return EM_DASH;
  const { month, day } = parseIsoDate(iso);
  return `${day} ${MONTH_LABELS[month - 1]}`;
}

/** 1 -> "st", 2 -> "nd", 3 -> "rd", 11 -> "th" - the reference UI's `nth()`. */
export function ordinalSuffix(day: number): string {
  const d = Math.trunc(day);
  if (d % 10 === 1 && d !== 11) return 'st';
  if (d % 10 === 2 && d !== 12) return 'nd';
  if (d % 10 === 3 && d !== 13) return 'rd';
  return 'th';
}

export const formatOrdinalDay = (day: number): string => `${Math.trunc(day)}${ordinalSuffix(day)}`;
