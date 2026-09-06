/**
 * Salary payments.
 *
 * A salary month is settled by one or more rows in `salary_payments`; there is
 * no boolean "paid" flag anywhere. What is outstanding for a month is always
 *
 *     balance = max(0, staff.monthlySalary - SUM(payments for that month))
 *
 * so a part payment is simply a smaller row, and the "Full" button asks the
 * server for the remainder rather than the browser working it out.
 */
import type { z } from 'zod';
import type {
  CreateSalaryPaymentInput,
  MonthKey,
  PaginationMeta,
  SalaryPaymentDto,
  UpdateSalaryPaymentInput,
  salaryListQuerySchema,
  settleSalarySchema,
} from '@hostel/shared';
import { isoDateToUtcDate, monthKeyToUtcDate } from '@hostel/shared';
import type { Prisma } from '@prisma/client';
import { runInTransaction } from '../db/prisma';
import { balanceOf, rupeesToPaise, ZERO, type Paise } from '../db/money';
import { ConflictError, UnprocessableError, salaryPaymentNotFound } from '../errors/app-error';
import type { AuthContext } from '../auth/context';
import { recordAudit } from './audit.service';
import { getFeeContext } from './settings.service';
import { toSalaryPaymentDto } from './mappers';
import { getStaffOrThrow } from './staff.service';
import {
  countSalaryPayments,
  createSalaryPaymentRow,
  deleteSalaryPaymentRow,
  findSalaryPaymentById,
  findSalaryPaymentPage,
  lockStaffRow,
  salaryPaymentOrderBy,
  salaryPaymentWhere,
  sumSalaryPaid,
  updateSalaryPaymentRow,
} from '../repositories/staff.repository';

export type SalaryListQuery = z.infer<typeof salaryListQuerySchema>;
export type SettleSalaryInput = z.infer<typeof settleSalarySchema>;

export interface SalaryListResult {
  items: SalaryPaymentDto[];
  meta: PaginationMeta;
}

export async function listSalaryPayments(query: SalaryListQuery): Promise<SalaryListResult> {
  const where = salaryPaymentWhere({
    month: query.month,
    buildingId: query.buildingId,
    staffId: query.staffId,
    search: query.search,
  });

  const [total, rows] = await Promise.all([
    countSalaryPayments(where),
    findSalaryPaymentPage(where, {
      orderBy: salaryPaymentOrderBy(query.sortBy, query.sortOrder),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return {
    items: rows.map(toSalaryPaymentDto),
    meta: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
  };
}

/** Somebody who has left the hostel's employment is not paid a new salary. */
function assertStillEmployed(staff: { name: string; active: boolean }): void {
  if (!staff.active) {
    throw new UnprocessableError(
      `${staff.name} is marked as left. Set them back to working before recording a salary payment.`,
      'STAFF_INACTIVE',
    );
  }
}

export async function createSalaryPayment(
  input: CreateSalaryPaymentInput,
  auth: AuthContext,
): Promise<SalaryPaymentDto> {
  const { context } = await getFeeContext();
  const paymentDate = input.paymentDate ?? context.today;

  const payment = await runInTransaction(async (tx) => {
    const staff = await getStaffOrThrow(input.staffId, tx);
    assertStillEmployed(staff);

    const created = await createSalaryPaymentRow(
      buildPaymentData({
        staffId: staff.id,
        salaryMonth: input.salaryMonth,
        // A request body is in RUPEES; this is the one place it is converted.
        amount: rupeesToPaise(input.amount),
        paymentDate,
        paymentMethod: input.paymentMethod,
        note: input.note ?? null,
        createdById: auth.userId || null,
      }),
      tx,
    );

    await recordAudit(tx, {
      auth,
      action: 'CREATE',
      entityType: 'SALARY_PAYMENT',
      entityId: created.id,
      summary: `Salary payment for ${staff.name} - ${input.salaryMonth}`,
      newData: toSalaryPaymentDto(created),
    });

    return created;
  });

  return toSalaryPaymentDto(payment);
}

/**
 * The "Full" button. The browser never sends an amount: the server reads what
 * is already paid for that month inside the transaction and inserts exactly the
 * remainder, so two managers pressing it at once cannot double-pay.
 *
 * `lockStaffRow` is what makes that last clause true on MongoDB. There is no
 * `SELECT ... FOR UPDATE` here, and snapshot isolation does NOT make two
 * transactions conflict merely because they read the same document - so the
 * repository writes the staff document instead, and the second concurrent
 * settlement is aborted with a write conflict rather than paying the balance a
 * second time.
 */
export async function settleSalary(
  input: SettleSalaryInput,
  auth: AuthContext,
): Promise<SalaryPaymentDto> {
  const { context } = await getFeeContext();
  const paymentDate = input.paymentDate ?? context.today;

  const payment = await runInTransaction(async (tx) => {
    const staff = await getStaffOrThrow(input.staffId, tx);
    assertStillEmployed(staff);

    await lockStaffRow(staff.id, tx);
    // Both sides are already in paise: the stored salary and the aggregate over
    // the month's payments. The remainder is written to the column as-is.
    const alreadyPaid = await sumSalaryPaid(staff.id, input.salaryMonth, tx);
    const balance = balanceOf(staff.monthlySalary, alreadyPaid);
    if (balance === ZERO) throw new ConflictError('That salary is already fully paid.');

    const created = await createSalaryPaymentRow(
      buildPaymentData({
        staffId: staff.id,
        salaryMonth: input.salaryMonth,
        amount: balance,
        paymentDate,
        paymentMethod: input.paymentMethod,
        note: input.note ?? null,
        createdById: auth.userId || null,
      }),
      tx,
    );

    await recordAudit(tx, {
      auth,
      action: 'CREATE',
      entityType: 'SALARY_PAYMENT',
      entityId: created.id,
      summary: `Settled salary balance for ${staff.name} - ${input.salaryMonth}`,
      newData: toSalaryPaymentDto(created),
    });

    return created;
  });

  return toSalaryPaymentDto(payment);
}

export async function updateSalaryPayment(
  id: string,
  input: UpdateSalaryPaymentInput,
  auth: AuthContext,
): Promise<SalaryPaymentDto> {
  const existing = await findSalaryPaymentById(id);
  if (!existing) throw salaryPaymentNotFound();
  const before = toSalaryPaymentDto(existing);

  const updated = await runInTransaction(async (tx) => {
    const data: Prisma.SalaryPaymentUncheckedUpdateInput = {
      ...(input.salaryMonth !== undefined
        ? { salaryMonth: monthKeyToUtcDate(input.salaryMonth) }
        : {}),
      ...(input.amount !== undefined ? { amount: rupeesToPaise(input.amount) } : {}),
      ...(input.paymentDate !== undefined
        ? { paymentDate: isoDateToUtcDate(input.paymentDate) }
        : {}),
      ...(input.paymentMethod !== undefined ? { paymentMethod: input.paymentMethod } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'note') ? { note: input.note ?? null } : {}),
    };

    const row = await updateSalaryPaymentRow(id, data, tx);

    await recordAudit(tx, {
      auth,
      action: 'UPDATE',
      entityType: 'SALARY_PAYMENT',
      entityId: id,
      summary: `Edited salary payment for ${row.staff?.name ?? 'staff member'}`,
      oldData: before,
      newData: toSalaryPaymentDto(row),
    });

    return row;
  });

  return toSalaryPaymentDto(updated);
}

export interface SalaryReversalDto {
  id: string;
  reversed: true;
  staffId: string;
  salaryMonth: MonthKey;
  amount: number;
}

/**
 * The register's undo. A salary payment carries no dependent records, so this
 * is a genuine delete - the audit row keeps the reversed amount on file.
 */
export async function deleteSalaryPayment(
  id: string,
  auth: AuthContext,
): Promise<SalaryReversalDto> {
  const existing = await findSalaryPaymentById(id);
  if (!existing) throw salaryPaymentNotFound();
  const before = toSalaryPaymentDto(existing);

  await runInTransaction(async (tx) => {
    await deleteSalaryPaymentRow(id, tx);
    await recordAudit(tx, {
      auth,
      action: 'DELETE',
      entityType: 'SALARY_PAYMENT',
      entityId: id,
      summary: `Reversed salary payment for ${before.staffName} - ${before.salaryMonth}`,
      oldData: before,
    });
  });

  return {
    id,
    reversed: true,
    staffId: before.staffId,
    salaryMonth: before.salaryMonth,
    amount: before.amount,
  };
}

/**
 * One place that turns month/date strings into the UTC-midnight DateTime values.
 *
 * `amount` arrives already in PAISE. Converting here instead would be wrong for
 * the settle path, whose amount comes from the database rather than from a
 * request body - it would multiply an already-scaled figure by a hundred.
 */
function buildPaymentData(input: {
  staffId: string;
  salaryMonth: MonthKey;
  /** Whole paise, converted by the caller. */
  amount: Paise;
  paymentDate: string;
  paymentMethod: CreateSalaryPaymentInput['paymentMethod'];
  note: string | null;
  createdById: string | null;
}): Prisma.SalaryPaymentUncheckedCreateInput {
  return {
    staffId: input.staffId,
    salaryMonth: monthKeyToUtcDate(input.salaryMonth),
    amount: input.amount,
    paymentDate: isoDateToUtcDate(input.paymentDate),
    paymentMethod: input.paymentMethod,
    note: input.note,
    createdById: input.createdById,
  };
}
