/**
 * Data-portability exports.
 *
 * These endpoints hand the owner a copy of records that already live in
 * PostgreSQL, in a format a spreadsheet or another system can read. They are
 * NOT a backup mechanism and they are not the browser-side JSON blob the
 * reference implementation used: nothing here is restorable, and nothing here
 * is the source of truth. The database is.
 *
 * Two details matter for correctness of the CSV:
 *
 *  1. RFC 4180 quoting - a field containing a comma, a double quote or a line
 *     break is wrapped in quotes and its own quotes are doubled.
 *  2. Formula injection - a text field beginning with `=`, `+`, `-` or `@` is
 *     prefixed with an apostrophe so Excel, LibreOffice and Sheets treat it as
 *     text rather than executing it. Numeric columns are written unguarded, so
 *     a negative amount stays a number rather than becoming text.
 */
import type {
  ExpenseDto,
  FeePaymentDto,
  IsoDate,
  ResidentDto,
} from '@hostel/shared';
import { todayIso } from '@hostel/shared';
import type { z } from 'zod';
import type { exportQuerySchema } from '@hostel/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { UnprocessableError } from '../errors/app-error';
import { getFeeContext } from './settings.service';
import { isEnrolled } from './fee-engine';
import {
  paymentInclude,
  residentInclude,
  toExpenseDto,
  toFeePaymentDto,
  toResidentDto,
} from './mappers';
import {
  expenseWhere,
  findExpensesForExport,
} from '../repositories/expense.repository';
import {
  dateRange,
  isAllBuildings,
  monthDateRange,
  residentBuildingWhere,
} from '../repositories/filters';

export type ExportQuery = z.infer<typeof exportQuerySchema>;
export type ExportKind = 'residents' | 'payments' | 'expenses';

export interface ExportFile {
  body: string;
  fileName: string;
  contentType: string;
}

/**
 * A hostel's whole history is far below this. The cap exists so a mistaken
 * filter cannot try to serialise an unbounded result set inside a Lambda; when
 * it is hit the caller is told to narrow the range rather than being handed a
 * silently truncated file.
 */
const EXPORT_ROW_LIMIT = 20_000;

const SHARED_LABEL = 'Shared';

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

export type CsvValue = string | number | boolean | null | undefined;

const NEEDS_QUOTING = /[",\r\n]/;
/** Leading characters a spreadsheet would treat as the start of a formula. */
const FORMULA_LEAD = /^[=+\-@]/;

export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  let text = value;
  if (FORMULA_LEAD.test(text)) text = `'${text}`;
  if (NEEDS_QUOTING.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers: readonly string[], rows: readonly CsvValue[][]): string {
  const lines: string[] = [headers.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function guardRowCount(count: number, kind: ExportKind): void {
  if (count > EXPORT_ROW_LIMIT) {
    throw new UnprocessableError(
      `That ${kind} export covers more than ${EXPORT_ROW_LIMIT.toLocaleString('en-IN')} records. Narrow the month or date range and try again.`,
      'EXPORT_TOO_LARGE',
    );
  }
}

/**
 * `format=json` returns the very same DTO array the REST endpoints serve, so a
 * downstream consumer never has to learn a second shape.
 */
function buildFile(
  kind: ExportKind,
  query: ExportQuery,
  headers: readonly string[],
  rows: readonly CsvValue[][],
  json: unknown,
  today: IsoDate,
): ExportFile {
  if (query.format === 'json') {
    return {
      body: `${JSON.stringify(json, null, 2)}\n`,
      fileName: `hostel-${kind}-${today}.json`,
      contentType: 'application/json',
    };
  }
  return {
    body: toCsv(headers, rows),
    fileName: `hostel-${kind}-${today}.csv`,
    contentType: 'text/csv',
  };
}

/* ------------------------------------------------------------------ *
 * Residents
 * ------------------------------------------------------------------ */

const RESIDENT_HEADERS = [
  'Id',
  'Name',
  'Phone',
  'Email',
  'Building',
  'Monthly fee',
  'Due day',
  'Joining month',
  'Joining date',
  'Vacated month',
  'Vacated date',
  'Status',
  'Has photo',
  'Has Aadhaar document',
  'Notes',
  'Recorded on',
] as const;

const residentStatus = (resident: ResidentDto): string => {
  if (!resident.active) return 'Archived';
  return resident.vacated ? 'Vacated' : 'Staying';
};

/**
 * Every resident on record, archived ones included - an export that quietly
 * dropped former residents would not be a copy of the data.
 * `month` narrows to the people actually enrolled that month; `from`/`to`
 * narrow by joining date.
 */
export async function exportResidents(query: ExportQuery): Promise<ExportFile> {
  const { settings, context } = await getFeeContext();
  const joined = dateRange(query.from, query.to);

  const where: Prisma.ResidentWhereInput = {
    ...residentBuildingWhere(query.buildingId),
    ...(joined ? { joinDate: joined } : {}),
  };

  const rows = await prisma.resident.findMany({
    where,
    include: residentInclude,
    orderBy: [{ name: 'asc' }],
    take: EXPORT_ROW_LIMIT + 1,
  });
  guardRowCount(rows.length, 'residents');

  const month = query.month;
  const inScope = month ? rows.filter((resident) => isEnrolled(resident, month)) : rows;
  const residents = inScope.map((resident) =>
    toResidentDto(resident, { currentMonth: context.currentMonth }),
  );

  return buildFile(
    'residents',
    query,
    RESIDENT_HEADERS,
    residents.map((resident) => [
      resident.id,
      resident.name,
      resident.phone,
      resident.email,
      resident.buildingName,
      resident.monthlyFee,
      resident.dueDay,
      resident.joinMonth,
      resident.joinDate,
      resident.vacatedMonth,
      resident.vacatedDate,
      residentStatus(resident),
      resident.hasPhoto,
      resident.hasAadhaarDocument,
      resident.notes,
      resident.createdAt,
    ]),
    residents,
    todayIso(settings.timezone),
  );
}

/* ------------------------------------------------------------------ *
 * Fee payments
 * ------------------------------------------------------------------ */

const PAYMENT_HEADERS = [
  'Id',
  'Resident',
  'Building',
  'Billing month',
  'Amount',
  'Payment date',
  'Method',
  'Reference',
  'Note',
  'Recorded by',
  'Recorded on',
] as const;

/** `month` filters the billing month; `from`/`to` filter the date money arrived. */
export async function exportPayments(query: ExportQuery): Promise<ExportFile> {
  const { settings } = await getFeeContext();
  const received = dateRange(query.from, query.to);

  const where: Prisma.FeePaymentWhereInput = {
    ...(query.month ? { billingMonth: monthDateRange(query.month) } : {}),
    ...(received ? { paymentDate: received } : {}),
    ...(isAllBuildings(query.buildingId)
      ? {}
      : { resident: residentBuildingWhere(query.buildingId) }),
  };

  const rows = await prisma.feePayment.findMany({
    where,
    include: paymentInclude,
    orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
    take: EXPORT_ROW_LIMIT + 1,
  });
  guardRowCount(rows.length, 'payments');

  const payments: FeePaymentDto[] = rows.map(toFeePaymentDto);

  return buildFile(
    'payments',
    query,
    PAYMENT_HEADERS,
    payments.map((payment) => [
      payment.id,
      payment.residentName,
      payment.buildingName,
      payment.billingMonth,
      payment.amount,
      payment.paymentDate,
      payment.paymentMethod,
      payment.referenceNumber,
      payment.note,
      payment.createdByName,
      payment.createdAt,
    ]),
    payments,
    todayIso(settings.timezone),
  );
}

/* ------------------------------------------------------------------ *
 * Expenses
 * ------------------------------------------------------------------ */

const EXPENSE_HEADERS = [
  'Id',
  'Date',
  'Building',
  'Category',
  'Amount',
  'Vendor',
  'Reference',
  'Note',
  'Recorded by',
  'Recorded on',
] as const;

export async function exportExpenses(query: ExportQuery): Promise<ExportFile> {
  const { settings } = await getFeeContext();

  const rows = await findExpensesForExport(
    expenseWhere({
      month: query.month,
      buildingId: query.buildingId,
      from: query.from,
      to: query.to,
    }),
    EXPORT_ROW_LIMIT + 1,
  );
  guardRowCount(rows.length, 'expenses');

  const expenses: ExpenseDto[] = rows.map(toExpenseDto);

  return buildFile(
    'expenses',
    query,
    EXPENSE_HEADERS,
    expenses.map((expense) => [
      expense.id,
      expense.date,
      expense.buildingName ?? SHARED_LABEL,
      expense.categoryName,
      expense.amount,
      expense.vendor,
      expense.referenceNumber,
      expense.note,
      expense.createdByName,
      expense.createdAt,
    ]),
    expenses,
    todayIso(settings.timezone),
  );
}
