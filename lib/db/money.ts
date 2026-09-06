/**
 * Money.
 *
 * Every amount on the server is a whole number of **paise**. MongoDB (through
 * Prisma) has no decimal type, and storing rupees as a floating-point number
 * would be the exact mistake this codebase exists to avoid: summing a hundred
 * rent payments would accumulate binary error and a month could report
 * PART_PAID forever because 4500.55 never quite equals 4500.55.
 *
 * Integers sidestep that completely. 450000 paise is 4,500.00 rupees, addition
 * is exact, and a balance of zero is exactly zero. JavaScript's safe integer
 * range covers ninety trillion rupees, which is comfortably more than any
 * hostel will collect.
 *
 * The conversion happens at exactly two boundaries:
 *   - input  : `rupeesToPaise()` when a validated request body becomes storage
 *   - output : `paiseToRupees()` when a document becomes a DTO
 * Everything in between - the fee engine, every aggregate, every comparison -
 * works in paise and never sees a fraction.
 */

/** A whole number of paise. */
export type Paise = number;

export const ZERO: Paise = 0;

const PAISE_PER_RUPEE = 100;

/** Ninety trillion rupees; beyond this we are outside exact integer maths. */
export const MAX_PAISE = Number.MAX_SAFE_INTEGER;

/**
 * Coerce a value that is *already* in paise (a stored field, an aggregate) into
 * a safe integer. Anything unusable becomes 0 rather than NaN, so a corrupt
 * document can never poison a total.
 */
export function toPaise(value: unknown): Paise {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value) : 0;
  }
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : 0;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
  }
  return 0;
}

/**
 * Convert a rupee amount from a validated request into paise.
 *
 * The `+ Number.EPSILON` nudge matters: 4500.55 * 100 is 450054.99999999994 in
 * binary floating point, and a bare Math.round would still give 450055, but
 * values such as 1.005 * 100 land just below the halfway point and would round
 * down. Scaling through a string-free epsilon correction keeps two-decimal
 * inputs exact, which is all the Zod schemas ever admit.
 */
export function rupeesToPaise(rupees: unknown): Paise {
  const value =
    typeof rupees === 'number'
      ? rupees
      : typeof rupees === 'string'
        ? Number.parseFloat(rupees)
        : Number.NaN;
  if (!Number.isFinite(value)) return 0;
  const scaled = Math.round((value + Number.EPSILON * Math.sign(value)) * PAISE_PER_RUPEE);
  return Number.isSafeInteger(scaled) ? scaled : 0;
}

/** Convert paise into the rupee number that crosses the API boundary. */
export function paiseToRupees(paise: unknown): number {
  const value = toPaise(paise);
  // Dividing by 100 can produce 45.129999999999995; fix to two places, which is
  // lossless because the numerator is an exact integer.
  return Number((value / PAISE_PER_RUPEE).toFixed(2));
}

export const sumPaise = (values: unknown[]): Paise =>
  values.reduce<Paise>((total, value) => total + toPaise(value), ZERO);

/**
 * max(0, expected - paid). A balance never goes negative: overpaying a month
 * does not create a credit, and does not roll into the next month.
 */
export function balanceOf(expected: unknown, paid: unknown): Paise {
  const difference = toPaise(expected) - toPaise(paid);
  return difference > 0 ? difference : ZERO;
}

export const isPositive = (value: unknown): boolean => toPaise(value) > 0;
export const isZero = (value: unknown): boolean => toPaise(value) === 0;

/** Percentage as a rounded integer, guarded against divide-by-zero. */
export function percent(part: unknown, whole: unknown): number {
  const denominator = toPaise(whole);
  if (denominator === 0) return 0;
  return Math.round((toPaise(part) / denominator) * 100);
}

/** Largest of a set, for scaling bar widths. Returns 0 for an empty set. */
export const maxPaise = (values: unknown[]): Paise =>
  values.reduce<Paise>((largest, value) => {
    const current = toPaise(value);
    return current > largest ? current : largest;
  }, ZERO);
