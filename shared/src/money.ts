/**
 * Money helpers.
 *
 * Authoritative storage is PostgreSQL `NUMERIC(14,2)` and authoritative
 * arithmetic happens server-side with Prisma's Decimal type. These helpers
 * exist for two narrow purposes:
 *
 *  1. Transport - amounts cross the API as JSON numbers with at most 2 decimal
 *     places. Every realistic hostel amount is far inside IEEE-754's exact
 *     integer range once scaled by 100, so transport is lossless.
 *  2. Presentation - formatting rupee amounts the way the reference UI does.
 *
 * Any addition performed on the client is presentational only; the backend
 * always returns its own authoritative totals.
 */
import { DEFAULT_CURRENCY_SYMBOL } from './constants.js';

/** Smallest representable unit (paise). */
const SCALE = 100;

/** Parse anything the API or a form might hand us into a finite number. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === 'object' && 'toString' in value) {
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Round to 2 decimal places without float drift (0.1 + 0.2 stays 0.30). */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * SCALE) / SCALE;
}

/** Exact-ish addition for presentation totals. */
export const addMoney = (...values: number[]): number =>
  roundMoney(values.reduce((sum, v) => sum + toNumber(v), 0));

export const subtractMoney = (a: number, b: number): number => roundMoney(toNumber(a) - toNumber(b));

/** Balance can never go negative - an overpayment does not become a credit here. */
export const clampBalance = (value: number): number => Math.max(0, roundMoney(value));

const groupingFormatter = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

const preciseFormatter = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

/**
 * Format an amount the way the reference UI does: Indian digit grouping, no
 * decimals (the hostel deals in whole rupees), prefixed with the configured
 * currency symbol. Paise are shown only when the amount actually has them.
 */
export function formatMoney(
  value: unknown,
  currencySymbol: string = DEFAULT_CURRENCY_SYMBOL,
  options: { showPaise?: boolean } = {},
): string {
  const amount = toNumber(value);
  const hasPaise = Math.abs(amount * SCALE) % SCALE !== 0;
  const formatter = options.showPaise ?? hasPaise ? preciseFormatter : groupingFormatter;
  return `${currencySymbol}${formatter.format(Math.abs(amount) < 0.005 ? 0 : amount)}`;
}

/**
 * Format a signed amount the way the reference UI renders negative net figures:
 * a leading minus sign followed by the absolute value.
 */
export function formatSignedMoney(
  value: unknown,
  currencySymbol: string = DEFAULT_CURRENCY_SYMBOL,
): string {
  const amount = toNumber(value);
  const sign = amount < 0 ? '−' : '';
  return `${sign}${formatMoney(Math.abs(amount), currencySymbol)}`;
}

/** Percentage of `part` within `whole`, rounded, guarded against divide-by-zero. */
export function percentOf(part: unknown, whole: unknown): number {
  const w = toNumber(whole);
  if (w === 0) return 0;
  return Math.round((toNumber(part) / w) * 100);
}
