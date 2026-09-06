/**
 * Fee payments.
 *
 * The rules this service enforces, and nothing else:
 *  * money is only ever recorded against a resident who exists, is not archived
 *    and was actually staying in the billing month being settled;
 *  * several payments may target one billing month - a top-up is a new row, an
 *    existing row is never quietly increased;
 *  * "settle" never trusts an amount from the browser: the outstanding balance
 *    is computed here from the ledger by the fee engine;
 *  * every write is a transaction that also writes its audit row, so a reversal
 *    can always be traced back to who made it and what the row contained.
 */
import type { z } from 'zod';
import type {
  CreatePaymentInput,
  FeePaymentDto,
  MonthKey,
  PaginationMeta,
  SettlePaymentInput,
  UpdatePaymentInput,
} from '@hostel/shared';
import {
  formatMonthLabel,
  formatMoney,
  isoDateToUtcDate,
  paymentListQuerySchema,
} from '@hostel/shared';
import type { AuthContext } from '../auth/context';
import { prisma, runInTransaction, type PrismaLike } from '../db/prisma';
import { rupeesToPaise, ZERO } from '../db/money';
import {
  ConflictError,
  UnprocessableError,
  paymentNotFound,
  residentNotFound,
} from '../errors/app-error';
import { buildPaginationMeta } from '../http/response';
import { billingMonthValue } from '../repositories/filters';
import {
  countPayments,
  deletePaymentRow,
  findMonthPayments,
  findPaymentById,
  findPayments,
  findResidentForPayment,
  insertPayment,
  paymentOrderBy,
  paymentWhere,
  updatePaymentRow,
  type PaymentResident,
  type PaymentUpdateData,
} from '../repositories/payment.repository';
import { recordAudit } from './audit.service';
import {
  buildPaymentIndex,
  isEnrolled,
  joinMonthOf,
  monthPosition,
  vacatedMonthOf,
} from './fee-engine';
import { toFeePaymentDto } from './mappers';
import { getFeeContext } from './settings.service';

export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;

export interface PaymentListResult {
  items: FeePaymentDto[];
  meta: PaginationMeta;
}

/** Default note for a settle-up, matching the reference UI's wording. */
const SETTLEMENT_NOTE = 'Arrears cleared';

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

async function loadResidentOrThrow(
  residentId: string,
  client: PrismaLike = prisma,
): Promise<PaymentResident> {
  const resident = await findResidentForPayment(residentId, client);
  if (!resident) throw residentNotFound();
  return resident;
}

function assertNotArchived(resident: PaymentResident): void {
  if (resident.active) return;
  throw new UnprocessableError(
    `${resident.name} is archived. Restore the resident before recording a payment.`,
    'RESIDENT_ARCHIVED',
  );
}

/** A fee can only exist for a month the resident was actually staying in. */
function assertEnrolled(resident: PaymentResident, month: MonthKey): void {
  if (isEnrolled(resident, month)) return;
  const vacated = vacatedMonthOf(resident);
  const window = vacated
    ? `${formatMonthLabel(joinMonthOf(resident))} to ${formatMonthLabel(vacated)}`
    : `${formatMonthLabel(joinMonthOf(resident))} onwards`;
  throw new UnprocessableError(
    `${resident.name} was not staying in ${formatMonthLabel(month)}. They are billed for ${window}.`,
    'NOT_ENROLLED_THAT_MONTH',
  );
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function listPayments(query: PaymentListQuery): Promise<PaymentListResult> {
  const where = paymentWhere({
    month: query.month,
    buildingId: query.buildingId,
    residentId: query.residentId,
    from: query.from,
    to: query.to,
    search: query.search,
  });

  const [total, rows] = await Promise.all([
    countPayments(where),
    findPayments({
      where,
      orderBy: paymentOrderBy(query.sortBy, query.sortOrder),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return {
    items: rows.map(toFeePaymentDto),
    meta: buildPaginationMeta(query.page, query.pageSize, total),
  };
}

export async function getPayment(id: string): Promise<FeePaymentDto> {
  const payment = await findPaymentById(id);
  if (!payment) throw paymentNotFound();
  return toFeePaymentDto(payment);
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

export async function createPayment(
  input: CreatePaymentInput,
  auth: AuthContext,
): Promise<FeePaymentDto> {
  const { settings, context } = await getFeeContext();
  const month = input.billingMonth;

  const resident = await loadResidentOrThrow(input.residentId);
  assertNotArchived(resident);
  assertEnrolled(resident, month);

  // "Today" is the hostel's today, never the Lambda region's.
  const paymentDate = input.paymentDate ?? context.today;

  return runInTransaction(async (tx) => {
    const row = await insertPayment(tx, {
      residentId: resident.id,
      billingMonth: billingMonthValue(month),
      amount: rupeesToPaise(input.amount),
      paymentDate: isoDateToUtcDate(paymentDate),
      paymentMethod: input.paymentMethod,
      referenceNumber: input.referenceNumber ?? null,
      note: input.note ?? null,
      createdById: auth.userId || null,
    });

    const dto = toFeePaymentDto(row);
    await recordAudit(tx, {
      auth,
      action: 'CREATE',
      entityType: 'FEE_PAYMENT',
      entityId: dto.id,
      summary: `Recorded ${formatMoney(dto.amount, settings.currency)} for ${resident.name} (${formatMonthLabel(month)})`,
      newData: dto,
    });

    return dto;
  });
}

export async function updatePayment(
  id: string,
  input: UpdatePaymentInput,
  auth: AuthContext,
): Promise<FeePaymentDto> {
  const { settings } = await getFeeContext();

  const existing = await findPaymentById(id);
  if (!existing) throw paymentNotFound();
  const before = toFeePaymentDto(existing);

  // Re-point a payment at another month only if the resident was billed for it.
  if (input.billingMonth !== undefined && input.billingMonth !== before.billingMonth) {
    const resident = await loadResidentOrThrow(existing.residentId);
    assertEnrolled(resident, input.billingMonth);
  }

  const data: PaymentUpdateData = {
    ...(input.billingMonth !== undefined
      ? { billingMonth: billingMonthValue(input.billingMonth) }
      : {}),
    ...(input.amount !== undefined ? { amount: rupeesToPaise(input.amount) } : {}),
    ...(input.paymentDate !== undefined
      ? { paymentDate: isoDateToUtcDate(input.paymentDate) }
      : {}),
    ...(input.paymentMethod !== undefined ? { paymentMethod: input.paymentMethod } : {}),
    // Key presence, not value: sending null clears the field, omitting the key
    // leaves it untouched.
    ...('referenceNumber' in input ? { referenceNumber: input.referenceNumber ?? null } : {}),
    ...('note' in input ? { note: input.note ?? null } : {}),
  };

  return runInTransaction(async (tx) => {
    const row = await updatePaymentRow(tx, id, data);
    const after = toFeePaymentDto(row);

    await recordAudit(tx, {
      auth,
      action: 'UPDATE',
      entityType: 'FEE_PAYMENT',
      entityId: id,
      summary: `Edited ${formatMoney(before.amount, settings.currency)} to ${formatMoney(after.amount, settings.currency)} for ${after.residentName} (${formatMonthLabel(after.billingMonth)})`,
      oldData: before,
      newData: after,
    });

    return after;
  });
}

export interface PaymentReversalDto {
  id: string;
  reversed: true;
}

/**
 * Delete a payment outright - the reference UI's "Undo".
 *
 * A fee payment carries no dependent rows, so archiving it would only leave a
 * ghost inside every balance the fee engine derives. The money is protected
 * instead by the audit row, which stores the entire deleted record in the same
 * transaction as the delete.
 */
export async function deletePayment(id: string, auth: AuthContext): Promise<PaymentReversalDto> {
  const { settings } = await getFeeContext();

  const existing = await findPaymentById(id);
  if (!existing) throw paymentNotFound();
  const before = toFeePaymentDto(existing);

  return runInTransaction(async (tx) => {
    await deletePaymentRow(tx, id);
    await recordAudit(tx, {
      auth,
      action: 'DELETE',
      entityType: 'FEE_PAYMENT',
      entityId: id,
      summary: `Reversed ${formatMoney(before.amount, settings.currency)} from ${before.residentName} (${formatMonthLabel(before.billingMonth)})`,
      oldData: before,
    });

    return { id, reversed: true };
  });
}

/**
 * Settle a billing month in full - the "Mark paid" and "Full" buttons.
 *
 * The amount is deliberately absent from the request schema. It is derived here
 * from the ledger by the fee engine, inside the transaction that writes it, so
 * a stale browser can never overpay or underpay a month.
 */
export async function settlePayment(
  input: SettlePaymentInput,
  auth: AuthContext,
): Promise<FeePaymentDto> {
  const { settings, context } = await getFeeContext();
  const month = input.billingMonth;
  const paymentDate = input.paymentDate ?? context.today;

  return runInTransaction(async (tx) => {
    const resident = await loadResidentOrThrow(input.residentId, tx);
    assertNotArchived(resident);
    assertEnrolled(resident, month);

    const ledger = await findMonthPayments(resident.id, month, tx);
    const position = monthPosition(resident, month, buildPaymentIndex(ledger), context);

    if (position.balance === ZERO) {
      throw new ConflictError('That month is already settled.');
    }

    const row = await insertPayment(tx, {
      residentId: resident.id,
      billingMonth: billingMonthValue(month),
      // The engine returns the balance in PAISE, which is exactly what the
      // column stores. Passing it through `rupeesToPaise` would multiply it by
      // a hundred and settle the month a hundred times over.
      amount: position.balance,
      paymentDate: isoDateToUtcDate(paymentDate),
      paymentMethod: input.paymentMethod,
      referenceNumber: null,
      note: input.note ?? SETTLEMENT_NOTE,
      createdById: auth.userId || null,
    });

    const dto = toFeePaymentDto(row);
    await recordAudit(tx, {
      auth,
      action: 'CREATE',
      entityType: 'FEE_PAYMENT',
      entityId: dto.id,
      summary: `Settled ${formatMoney(dto.amount, settings.currency)} for ${resident.name} (${formatMonthLabel(month)})`,
      newData: dto,
    });

    return dto;
  });
}
