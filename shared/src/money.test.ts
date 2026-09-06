/**
 * Money helper unit tests.
 *
 * These cover the transport/presentation layer only - authoritative arithmetic
 * lives in Prisma.Decimal on the server. What matters here is that float drift
 * never reaches a rupee figure, that a balance can never render as a credit,
 * and that formatting matches the Indian digit grouping the reference UI uses.
 *
 * The rupee sign and the typographic minus are written as escapes so the file's
 * encoding can never quietly change what is being asserted.
 */
import { describe, expect, it } from 'vitest';
import {
  addMoney,
  clampBalance,
  formatMoney,
  formatSignedMoney,
  percentOf,
  roundMoney,
  subtractMoney,
  toNumber,
} from './money.js';
import { DEFAULT_CURRENCY_SYMBOL } from './constants.js';

const RUPEE = '₹';
const MINUS = '−';

describe('roundMoney', () => {
  it('avoids binary float drift for 0.1 + 0.2', () => {
    // The raw sum is 0.30000000000000004; naive rounding of larger sums of this
    // shape is what puts a stray paisa on a statement.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
  });

  it('rounds half up at the paisa, including values float stores just below', () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(1234.567)).toBe(1234.57);
    expect(roundMoney(4500.555)).toBe(4500.56);
  });

  it('drops sub-paisa noise', () => {
    expect(roundMoney(5000.004)).toBe(5000);
    expect(roundMoney(1e-8)).toBe(0);
  });

  it('leaves whole rupee amounts untouched', () => {
    expect(roundMoney(5000)).toBe(5000);
    expect(roundMoney(0)).toBe(0);
  });

  it('returns 0 for non-finite input rather than propagating NaN into a total', () => {
    expect(roundMoney(Number.NaN)).toBe(0);
    expect(roundMoney(Number.POSITIVE_INFINITY)).toBe(0);
    expect(roundMoney(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('addMoney', () => {
  it('sums without drift', () => {
    expect(addMoney(0.1, 0.2)).toBe(0.3);
    expect(addMoney(1000.1, 2000.2, 3000.3)).toBe(6000.6);
  });

  it('sums a month of rent exactly', () => {
    expect(addMoney(5000, 5000, 4500, 3200.5)).toBe(17700.5);
  });

  it('returns 0 for no arguments', () => {
    expect(addMoney()).toBe(0);
  });

  it('ignores a non-finite member instead of poisoning the total', () => {
    expect(addMoney(5000, Number.NaN)).toBe(5000);
  });
});

describe('subtractMoney', () => {
  it('subtracts without drift and keeps the sign', () => {
    expect(subtractMoney(0.3, 0.1)).toBe(0.2);
    expect(subtractMoney(5000, 12000)).toBe(-7000);
  });
});

describe('clampBalance', () => {
  it('never returns a negative balance (an overpayment is not a credit)', () => {
    expect(clampBalance(-50)).toBe(0);
    expect(clampBalance(-0.004)).toBe(0);
    expect(clampBalance(-99999)).toBe(0);
  });

  it('rounds a positive balance to the paisa', () => {
    expect(clampBalance(1234.567)).toBe(1234.57);
    expect(clampBalance(5000)).toBe(5000);
  });
});

describe('formatMoney', () => {
  it('uses Indian digit grouping (lakh/crore), not thousands grouping', () => {
    expect(formatMoney(100000)).toBe(`${RUPEE}1,00,000`);
    expect(formatMoney(1234567)).toBe(`${RUPEE}12,34,567`);
    expect(formatMoney(12500)).toBe(`${RUPEE}12,500`);
    expect(formatMoney(1000)).toBe(`${RUPEE}1,000`);
  });

  it('defaults to the configured currency symbol and accepts an override', () => {
    expect(formatMoney(5000)).toBe(`${DEFAULT_CURRENCY_SYMBOL}5,000`);
    expect(formatMoney(5000, '$')).toBe('$5,000');
  });

  it('shows paise only when the amount actually has them', () => {
    expect(formatMoney(4500)).toBe(`${RUPEE}4,500`);
    expect(formatMoney(4500.5)).toBe(`${RUPEE}4,500.50`);
  });

  it('honours an explicit showPaise option in both directions', () => {
    expect(formatMoney(4500, RUPEE, { showPaise: true })).toBe(`${RUPEE}4,500.00`);
    expect(formatMoney(4500.5, RUPEE, { showPaise: false })).toBe(`${RUPEE}4,501`);
  });

  it('never renders a negative zero from a sub-paisa residue', () => {
    expect(formatMoney(0)).toBe(`${RUPEE}0`);
    // A residue below half a paisa is flattened to zero before formatting, so
    // the sign can never survive; it still shows paise because the residue
    // makes the amount look like a paise value.
    expect(formatMoney(0.001)).toBe(`${RUPEE}0.00`);
    expect(formatMoney(-0.001)).toBe(`${RUPEE}0.00`);
    expect(formatMoney(-0.001)).not.toContain('-');
    expect(formatMoney(0, RUPEE, { showPaise: false })).toBe(`${RUPEE}0`);
  });

  it('coerces whatever the API or a form hands it', () => {
    expect(formatMoney('12500')).toBe(`${RUPEE}12,500`);
    expect(formatMoney(null)).toBe(`${RUPEE}0`);
    expect(formatMoney(undefined)).toBe(`${RUPEE}0`);
    expect(formatMoney({ toString: () => '2500.75' })).toBe(`${RUPEE}2,500.75`);
  });
});

describe('formatSignedMoney', () => {
  it('renders a negative net with a leading minus before the symbol', () => {
    expect(formatSignedMoney(-2500)).toBe(`${MINUS}${RUPEE}2,500`);
    expect(formatSignedMoney(-1234567)).toBe(`${MINUS}${RUPEE}12,34,567`);
  });

  it('uses the typographic minus, not the hyphen formatMoney would emit', () => {
    expect(formatMoney(-2500)).toBe(`${RUPEE}-2,500`);
    expect(formatSignedMoney(-2500)).not.toBe(formatMoney(-2500));
    expect(formatSignedMoney(-2500).startsWith(MINUS)).toBe(true);
  });

  it('adds no sign to a positive or zero amount', () => {
    expect(formatSignedMoney(2500)).toBe(`${RUPEE}2,500`);
    expect(formatSignedMoney(0)).toBe(`${RUPEE}0`);
  });
});

describe('percentOf', () => {
  it('returns a rounded integer percentage', () => {
    expect(percentOf(50, 200)).toBe(25);
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(12000, 15000)).toBe(80);
  });

  it('guards divide-by-zero instead of returning NaN or Infinity', () => {
    expect(percentOf(5000, 0)).toBe(0);
    expect(percentOf(0, 0)).toBe(0);
    expect(percentOf(5000, null)).toBe(0);
  });

  it('coerces string inputs', () => {
    expect(percentOf('50', '200')).toBe(25);
  });
});

describe('toNumber', () => {
  it('passes finite numbers through and neutralises the rest', () => {
    expect(toNumber(4500.5)).toBe(4500.5);
    expect(toNumber(0)).toBe(0);
    expect(toNumber(Number.NaN)).toBe(0);
    expect(toNumber(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('parses strings, including grouped ones straight out of a form', () => {
    expect(toNumber('1,25,000')).toBe(125000);
    expect(toNumber('  4500.50 ')).toBe(4500.5);
    expect(toNumber('abc')).toBe(0);
    expect(toNumber('')).toBe(0);
  });

  it('coerces a Decimal-like object via its toString', () => {
    // Prisma.Decimal is exactly this shape as far as the client is concerned.
    expect(toNumber({ toString: () => '1234.56' })).toBe(1234.56);
    expect(toNumber({})).toBe(0);
  });

  it('coerces bigint and rejects everything else', () => {
    expect(toNumber(42n)).toBe(42);
    expect(toNumber(true)).toBe(0);
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
  });
});
