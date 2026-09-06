/**
 * Fee payment persistence.
 *
 * Every query-shaped concern for the fee ledger lives here: the filter the list
 * endpoint shares with its count, the ordering map, and the narrow reads a
 * mutation needs before it writes. No business rule is decided in this file -
 * balances, statuses and due dates all come from `lib/services/fee-engine.ts`.
 *
 * Amounts are integer PAISE everywhere in this file; rupees exist only in the
 * request body and the DTO.
 */
import type { Prisma } from '@prisma/client';
import type { MonthKey, PaymentMethod } from '@hostel/shared';
import { prisma, type PrismaLike } from '../db/prisma';
import { paymentInclude, type PaymentWithRelations } from '../services/mappers';
import type { FeePaymentRow } from '../services/fee-engine';
import {
  dateRange,
  monthDateRange,
  residentBuildingWhere,
  searchFilter,
  type BuildingFilter,
} from './filters';

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export interface PaymentListFilters {
  /** Payments whose *billing* month is this month (not the month cash arrived). */
  month?: MonthKey;
  buildingId?: BuildingFilter;
  residentId?: string;
  /** Inclusive calendar range on paymentDate. */
  from?: string;
  to?: string;
  /** Resident name, reference number or note. */
  search?: string;
}

export type PaymentSortBy = 'paymentDate' | 'amount' | 'billingMonth' | 'createdAt';
export type SortOrder = 'asc' | 'desc';

export function paymentWhere(filters: PaymentListFilters): Prisma.FeePaymentWhereInput {
  const where: Prisma.FeePaymentWhereInput = {};

  if (filters.month) where.billingMonth = monthDateRange(filters.month);

  const paymentDate = dateRange(filters.from, filters.to);
  if (paymentDate) where.paymentDate = paymentDate;

  if (filters.residentId) where.residentId = filters.residentId;

  // A payment inherits its building from the resident it belongs to. A resident
  // always has a building, so the "shared" sentinel matches nothing.
  if (filters.buildingId) {
    const scope = residentBuildingWhere(filters.buildingId);
    if (Object.keys(scope).length > 0) where.resident = scope;
  }

  const term = searchFilter(filters.search);
  if (term) {
    where.OR = [{ resident: { name: term } }, { referenceNumber: term }, { note: term }];
  }

  return where;
}

export function paymentOrderBy(
  sortBy: PaymentSortBy,
  sortOrder: SortOrder,
): Prisma.FeePaymentOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'amount':
      return [{ amount: sortOrder }, { paymentDate: 'desc' }, { createdAt: 'desc' }];
    case 'billingMonth':
      return [{ billingMonth: sortOrder }, { paymentDate: 'desc' }, { createdAt: 'desc' }];
    case 'createdAt':
      return [{ createdAt: sortOrder }];
    default:
      // Two payments can share a date; createdAt keeps paging deterministic.
      return [{ paymentDate: sortOrder }, { createdAt: sortOrder }];
  }
}

export function countPayments(
  where: Prisma.FeePaymentWhereInput,
  client: PrismaLike = prisma,
): Promise<number> {
  return client.feePayment.count({ where });
}

export function findPayments(
  args: {
    where: Prisma.FeePaymentWhereInput;
    orderBy: Prisma.FeePaymentOrderByWithRelationInput[];
    skip: number;
    take: number;
  },
  client: PrismaLike = prisma,
): Promise<PaymentWithRelations[]> {
  return client.feePayment.findMany({
    where: args.where,
    orderBy: args.orderBy,
    skip: args.skip,
    take: args.take,
    include: paymentInclude,
  });
}

export function findPaymentById(
  id: string,
  client: PrismaLike = prisma,
): Promise<PaymentWithRelations | null> {
  return client.feePayment.findUnique({ where: { id }, include: paymentInclude });
}

/** Exactly the columns the fee engine needs to bill a resident. */
export const PAYMENT_RESIDENT_SELECT = {
  id: true,
  name: true,
  buildingId: true,
  monthlyFee: true,
  dueDay: true,
  joinDate: true,
  vacatedDate: true,
  active: true,
} satisfies Prisma.ResidentSelect;

export type PaymentResident = Prisma.ResidentGetPayload<{
  select: typeof PAYMENT_RESIDENT_SELECT;
}>;

export function findResidentForPayment(
  residentId: string,
  client: PrismaLike = prisma,
): Promise<PaymentResident | null> {
  return client.resident.findUnique({
    where: { id: residentId },
    select: PAYMENT_RESIDENT_SELECT,
  });
}

/**
 * Every payment allocated to one resident's billing month.
 * One query; the caller folds it into a payment index for the fee engine, which
 * is what makes "settle" compute the outstanding balance server-side.
 */
export function findMonthPayments(
  residentId: string,
  month: MonthKey,
  client: PrismaLike = prisma,
): Promise<FeePaymentRow[]> {
  return client.feePayment.findMany({
    where: { residentId, billingMonth: monthDateRange(month) },
    select: { residentId: true, billingMonth: true, amount: true },
  });
}

/* ------------------------------------------------------------------ *
 * Writes - always called with a transaction client
 * ------------------------------------------------------------------ */

export interface PaymentWriteData {
  residentId: string;
  /** First day of the billing month, built with `billingMonthValue`. */
  billingMonth: Date;
  /** Paise, already converted from the validated rupee input. */
  amount: number;
  paymentDate: Date;
  paymentMethod: PaymentMethod;
  referenceNumber: string | null;
  note: string | null;
  createdById: string | null;
}

export interface PaymentUpdateData {
  billingMonth?: Date;
  /** Paise. */
  amount?: number;
  paymentDate?: Date;
  paymentMethod?: PaymentMethod;
  referenceNumber?: string | null;
  note?: string | null;
}

export function insertPayment(
  client: PrismaLike,
  data: PaymentWriteData,
): Promise<PaymentWithRelations> {
  return client.feePayment.create({ data, include: paymentInclude });
}

export function updatePaymentRow(
  client: PrismaLike,
  id: string,
  data: PaymentUpdateData,
): Promise<PaymentWithRelations> {
  return client.feePayment.update({ where: { id }, data, include: paymentInclude });
}

/**
 * Hard delete. This is the reference UI's "Undo" on a mis-keyed entry, so the
 * row really does go; the caller MUST write the full old row to the audit log
 * in the same transaction.
 */
export async function deletePaymentRow(client: PrismaLike, id: string): Promise<void> {
  await client.feePayment.delete({ where: { id } });
}
