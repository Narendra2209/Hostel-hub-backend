import { z } from 'zod';
import { PAGINATION } from '../constants.js';
import { isIsoDate, isMonthKey } from '../date.js';

/**
 * A primary key.
 *
 * MongoDB ids are 24-character hexadecimal ObjectIds, not UUIDs. Validating
 * with `.uuid()` would reject every real id in the database, so the check is on
 * the ObjectId shape instead. `uuidSchema` remains as an alias because it is
 * referenced widely; new code should use `idSchema`.
 */
export const idSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

/** @deprecated Use `idSchema`. Kept so existing imports keep working. */
export const uuidSchema = idSchema;

/** True when a string looks like a MongoDB ObjectId. */
export const isObjectId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value.trim());

/** "2026-08" */
export const monthKeySchema = z
  .string()
  .trim()
  .refine(isMonthKey, { message: 'Month must look like 2026-08' });

/** "2026-08-15" */
export const isoDateSchema = z
  .string()
  .trim()
  .refine(isIsoDate, { message: 'Date must look like 2026-08-15' });

/**
 * A month input that also accepts a full ISO date and narrows it to its month,
 * so `<input type="month">` and `<input type="date">` both work.
 */
export const monthLikeSchema = z
  .string()
  .trim()
  .transform((value) => (isIsoDate(value) ? value.slice(0, 7) : value))
  .refine(isMonthKey, { message: 'Month must look like 2026-08' });

/** A rupee amount. Stored as NUMERIC(14,2); we accept at most 2 decimals. */
export const moneySchema = z.coerce
  .number({ invalid_type_error: 'Enter a number' })
  .finite('Enter a valid amount')
  .min(0, 'Amount cannot be negative')
  .max(9_999_999_999.99, 'Amount is too large')
  .refine((n) => Math.round(n * 100) === Number((n * 100).toFixed(0)), {
    message: 'At most two decimal places',
  });

export const positiveMoneySchema = moneySchema.refine((n) => n > 0, {
  message: 'Enter an amount above zero',
});

export const dueDaySchema = z.coerce
  .number({ invalid_type_error: 'Enter a day' })
  .int('Enter a whole number')
  .min(1, 'Due day must be between 1 and 31')
  .max(31, 'Due day must be between 1 and 31');

/** Trims, and turns "" into undefined so optional text fields clear cleanly. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .transform((v) => (v.length === 0 ? undefined : v))
    .optional()
    .nullable()
    .transform((v) => v ?? undefined);

export const phoneSchema = z
  .string()
  .trim()
  .max(20, 'Phone number is too long')
  .regex(/^[0-9+\-()\s]*$/, 'Phone number has unexpected characters')
  .transform((v) => (v.length === 0 ? undefined : v))
  .optional()
  .nullable()
  .transform((v) => v ?? undefined);

export const emailSchema = z
  .string()
  .trim()
  .max(180)
  .email('Enter a valid email address')
  .optional()
  .or(z.literal(''))
  .transform((v) => (v ? v : undefined));

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(PAGINATION.DEFAULT_PAGE),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGINATION.MAX_PAGE_SIZE)
    .default(PAGINATION.DEFAULT_PAGE_SIZE),
  search: z.string().trim().max(120).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

/**
 * The building filter used across every screen.
 * "all" means no filter; "shared" means records with no building attached.
 */
export const buildingFilterSchema = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : 'all'))
  .refine((v) => v === 'all' || v === 'shared' || isObjectId(v), {
    message: 'Building filter must be "all", "shared" or a building id',
  });

export const yearSchema = z.coerce
  .number()
  .int()
  .min(2000, 'Year is out of range')
  .max(2200, 'Year is out of range');
