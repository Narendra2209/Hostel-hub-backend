import { z } from 'zod';
import { PAYMENT_METHODS, USER_ROLES } from '../types.js';
import {
  dueDaySchema,
  emailSchema,
  isoDateSchema,
  monthLikeSchema,
  moneySchema,
  optionalText,
  phoneSchema,
  positiveMoneySchema,
  uuidSchema,
} from './common.js';

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export const updateSettingsSchema = z
  .object({
    hostelName: z.string().trim().min(1, 'Enter a hostel name').max(120),
    currency: z.string().trim().min(1, 'Enter a currency symbol').max(8),
    currencyCode: z.string().trim().length(3, 'Use a 3-letter code such as INR').toUpperCase(),
    defaultDueDay: dueDaySchema,
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(
        (tz) => {
          try {
            new Intl.DateTimeFormat('en-CA', { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        },
        { message: 'Not a recognised IANA timezone' },
      ),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

/* ------------------------------------------------------------------ *
 * Buildings
 * ------------------------------------------------------------------ */

export const createBuildingSchema = z.object({
  name: z.string().trim().min(1, 'Enter a building name').max(120),
  code: optionalText(24),
  address: optionalText(300),
  active: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});

export const updateBuildingSchema = createBuildingSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type CreateBuildingInput = z.infer<typeof createBuildingSchema>;
export type UpdateBuildingInput = z.infer<typeof updateBuildingSchema>;

/* ------------------------------------------------------------------ *
 * Expense categories
 * ------------------------------------------------------------------ */

export const createExpenseCategorySchema = z.object({
  name: z.string().trim().min(1, 'Enter a category name').max(80),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(500),
  active: z.boolean().default(true),
});

export const updateExpenseCategorySchema = createExpenseCategorySchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

/* ------------------------------------------------------------------ *
 * Residents
 * ------------------------------------------------------------------ */

const residentBase = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters').max(150),
  phone: phoneSchema,
  email: emailSchema,
  buildingId: uuidSchema,
  monthlyFee: moneySchema,
  dueDay: dueDaySchema,
  /** The UI collects a month; a full date is accepted and normalised server-side. */
  joinMonth: monthLikeSchema,
  vacatedMonth: monthLikeSchema.optional().nullable(),
  notes: optionalText(2000),
});

export const createResidentSchema = residentBase.superRefine((value, ctx) => {
  if (value.vacatedMonth && value.vacatedMonth < value.joinMonth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['vacatedMonth'],
      message: 'Vacated month cannot be before the joining month',
    });
  }
});

export const updateResidentSchema = residentBase
  .extend({ active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .superRefine((value, ctx) => {
    if (value.vacatedMonth && value.joinMonth && value.vacatedMonth < value.joinMonth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vacatedMonth'],
        message: 'Vacated month cannot be before the joining month',
      });
    }
  });

export const vacateResidentSchema = z.object({
  vacatedMonth: monthLikeSchema,
  notes: optionalText(500),
});

export const moveResidentSchema = z.object({
  toBuildingId: uuidSchema,
  effectiveDate: isoDateSchema.optional(),
  notes: optionalText(500),
});

export type CreateResidentInput = z.infer<typeof createResidentSchema>;
export type UpdateResidentInput = z.infer<typeof updateResidentSchema>;
export type MoveResidentInput = z.infer<typeof moveResidentSchema>;
export type VacateResidentInput = z.infer<typeof vacateResidentSchema>;

/* ------------------------------------------------------------------ *
 * Fee payments
 * ------------------------------------------------------------------ */

export const createPaymentSchema = z.object({
  residentId: uuidSchema,
  billingMonth: monthLikeSchema,
  amount: positiveMoneySchema,
  paymentDate: isoDateSchema.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).default('CASH'),
  referenceNumber: optionalText(80),
  note: optionalText(500),
});

export const updatePaymentSchema = z
  .object({
    billingMonth: monthLikeSchema,
    amount: positiveMoneySchema,
    paymentDate: isoDateSchema,
    paymentMethod: z.enum(PAYMENT_METHODS),
    referenceNumber: optionalText(80),
    note: optionalText(500),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

/** "Settle" / "Mark paid" - the backend works out the outstanding balance itself. */
export const settlePaymentSchema = z.object({
  residentId: uuidSchema,
  billingMonth: monthLikeSchema,
  paymentDate: isoDateSchema.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).default('CASH'),
  note: optionalText(500),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;
export type SettlePaymentInput = z.infer<typeof settlePaymentSchema>;

/* ------------------------------------------------------------------ *
 * Staff
 * ------------------------------------------------------------------ */

const staffBase = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters').max(150),
  phone: phoneSchema,
  role: optionalText(80),
  /** null / omitted means shared across all buildings. */
  buildingId: uuidSchema.optional().nullable(),
  monthlySalary: moneySchema,
  active: z.boolean().default(true),
  joinDate: isoDateSchema.optional().nullable(),
  endDate: isoDateSchema.optional().nullable(),
  notes: optionalText(2000),
});

export const createStaffSchema = staffBase.superRefine((value, ctx) => {
  if (value.joinDate && value.endDate && value.endDate < value.joinDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endDate'],
      message: 'End date cannot be before the joining date',
    });
  }
});

export const updateStaffSchema = staffBase
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;

/* ------------------------------------------------------------------ *
 * Salary payments
 * ------------------------------------------------------------------ */

export const createSalaryPaymentSchema = z.object({
  staffId: uuidSchema,
  salaryMonth: monthLikeSchema,
  amount: positiveMoneySchema,
  paymentDate: isoDateSchema.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).default('CASH'),
  note: optionalText(500),
});

export const updateSalaryPaymentSchema = z
  .object({
    salaryMonth: monthLikeSchema,
    amount: positiveMoneySchema,
    paymentDate: isoDateSchema,
    paymentMethod: z.enum(PAYMENT_METHODS),
    note: optionalText(500),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const settleSalarySchema = z.object({
  staffId: uuidSchema,
  salaryMonth: monthLikeSchema,
  paymentDate: isoDateSchema.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).default('CASH'),
  note: optionalText(500),
});

export type CreateSalaryPaymentInput = z.infer<typeof createSalaryPaymentSchema>;
export type UpdateSalaryPaymentInput = z.infer<typeof updateSalaryPaymentSchema>;

/* ------------------------------------------------------------------ *
 * Expenses
 * ------------------------------------------------------------------ */

export const createExpenseSchema = z.object({
  date: isoDateSchema,
  /** null / omitted means a shared cost. */
  buildingId: uuidSchema.optional().nullable(),
  categoryId: uuidSchema,
  amount: positiveMoneySchema,
  vendor: optionalText(120),
  referenceNumber: optionalText(80),
  note: optionalText(500),
});

export const updateExpenseSchema = createExpenseSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    role: z.enum(USER_ROLES),
    active: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
