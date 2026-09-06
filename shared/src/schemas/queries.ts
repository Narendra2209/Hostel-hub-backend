import { z } from 'zod';
import { UPLOAD_LIMITS } from '../constants.js';
import {
  buildingFilterSchema,
  idSchema,
  isoDateSchema,
  monthLikeSchema,
  paginationQuerySchema,
  uuidSchema,
  yearSchema,
} from './common.js';
import { PAYMENT_STATUSES } from '../types.js';

/** Filters shared by nearly every list endpoint. */
export const monthBuildingQuerySchema = z.object({
  month: monthLikeSchema.optional(),
  buildingId: buildingFilterSchema,
});

export const dashboardQuerySchema = monthBuildingQuerySchema.extend({
  year: yearSchema.optional(),
  /** How many residents appear in the Jan-Dec fee-card table. */
  stripLimit: z.coerce.number().int().min(0).max(200).default(15),
});

export const residentListQuerySchema = paginationQuerySchema.extend({
  buildingId: buildingFilterSchema,
  month: monthLikeSchema.optional(),
  status: z.enum(['all', 'staying', 'vacated', 'archived']).default('staying'),
  sortBy: z.enum(['name', 'monthlyFee', 'joinDate', 'dueDay', 'building']).default('name'),
  /** Skip the per-month fee derivation when a caller only needs the roster. */
  includeFees: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export const feeLedgerQuerySchema = z.object({
  month: monthLikeSchema.optional(),
  buildingId: buildingFilterSchema,
  search: z.string().trim().max(120).optional(),
  status: z.enum(['all', ...PAYMENT_STATUSES]).default('all'),
  sortBy: z.enum(['name', 'balance', 'expected', 'paid', 'dueDate']).default('name'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export const feeStatusQuerySchema = z.object({
  year: yearSchema,
});

export const feeStatusBatchQuerySchema = z.object({
  year: yearSchema,
  buildingId: buildingFilterSchema,
  residentIds: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
    .refine((ids) => !ids || ids.every((id) => idSchema.safeParse(id).success), {
      message: 'residentIds must be a comma-separated list of ids',
    })
    .refine((ids) => !ids || ids.length <= 200, { message: 'At most 200 residents per request' }),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const paymentListQuerySchema = paginationQuerySchema.extend({
  month: monthLikeSchema.optional(),
  buildingId: buildingFilterSchema,
  residentId: uuidSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  sortBy: z.enum(['paymentDate', 'amount', 'billingMonth', 'createdAt']).default('paymentDate'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const overdueQuerySchema = paginationQuerySchema.extend({
  buildingId: buildingFilterSchema,
  /** "month" lists one row per unpaid month; "resident" groups by person. */
  groupBy: z.enum(['month', 'resident']).default('month'),
  sortBy: z.enum(['daysOverdue', 'balance', 'name', 'month']).default('daysOverdue'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export const staffListQuerySchema = paginationQuerySchema.extend({
  buildingId: buildingFilterSchema,
  month: monthLikeSchema.optional(),
  status: z.enum(['all', 'active', 'inactive']).default('all'),
  sortBy: z.enum(['name', 'monthlySalary', 'role']).default('name'),
});

export const salaryListQuerySchema = paginationQuerySchema.extend({
  month: monthLikeSchema.optional(),
  buildingId: buildingFilterSchema,
  staffId: uuidSchema.optional(),
  sortBy: z.enum(['paymentDate', 'amount', 'salaryMonth']).default('paymentDate'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const expenseListQuerySchema = paginationQuerySchema.extend({
  month: monthLikeSchema.optional(),
  buildingId: buildingFilterSchema,
  categoryId: uuidSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  sortBy: z.enum(['date', 'amount', 'category']).default('date'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export const pnlQuerySchema = monthBuildingQuerySchema.extend({
  year: yearSchema.optional(),
});

export const auditLogQuerySchema = paginationQuerySchema.extend({
  entityType: z.string().trim().max(40).optional(),
  entityId: uuidSchema.optional(),
  userId: uuidSchema.optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/** Filters for the activity log screen. */
export const activityQuerySchema = paginationQuerySchema.extend({
  entityType: z.string().trim().max(40).optional(),
  entityId: idSchema.optional(),
  actorId: idSchema.optional(),
  action: z.string().trim().max(20).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const exportQuerySchema = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  month: monthLikeSchema.optional(),
  buildingId: buildingFilterSchema,
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

/* ------------------------------------------------------------------ *
 * Uploads
 * ------------------------------------------------------------------ */

export const presignUploadSchema = z
  .object({
    residentId: uuidSchema,
    kind: z.enum(['photo', 'aadhaar']),
    contentType: z.string().trim().min(1).max(120),
    fileName: z.string().trim().max(255).optional(),
    contentLength: z.coerce.number().int().positive('File appears to be empty'),
  })
  .superRefine((value, ctx) => {
    const allowed =
      value.kind === 'photo'
        ? (UPLOAD_LIMITS.PHOTO_MIME_TYPES as readonly string[])
        : (UPLOAD_LIMITS.DOCUMENT_MIME_TYPES as readonly string[]);
    if (!allowed.includes(value.contentType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentType'],
        message: `Allowed file types: ${allowed.join(', ')}`,
      });
    }
    const max =
      value.kind === 'photo' ? UPLOAD_LIMITS.MAX_IMAGE_BYTES : UPLOAD_LIMITS.MAX_DOCUMENT_BYTES;
    if (value.contentLength > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentLength'],
        message: `File must be ${Math.round(max / (1024 * 1024))} MB or smaller`,
      });
    }
  });

/** Called after the browser's PUT to S3 succeeds, to persist the object key. */
export const confirmUploadSchema = z.object({
  residentId: uuidSchema,
  kind: z.enum(['photo', 'aadhaar']),
  objectKey: z.string().trim().min(1).max(512),
});

export type PresignUploadInput = z.infer<typeof presignUploadSchema>;
export type ConfirmUploadInput = z.infer<typeof confirmUploadSchema>;
