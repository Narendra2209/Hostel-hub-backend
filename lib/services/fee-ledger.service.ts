/**
 * The monthly fee ledger - one screen, one month, one pair of queries.
 *
 * `loadRosterWithLedger` fetches the residents and the month's payments; the fee
 * engine turns those two result sets into a position per resident. Nothing here
 * queries inside a loop, and nothing here re-derives a due date, a status or a
 * balance - `monthPosition` and `monthTotals` own all of that.
 *
 * Status, balance and due date are *derived*, so they cannot be filtered or
 * sorted in SQL. The search/status filters and the sort are therefore applied
 * after the positions are computed, over an in-memory list that is one month of
 * one hostel.
 */
import type { z } from 'zod';
import type {
  FeeLedgerResponseDto,
  FeeLedgerRowDto,
  FeeLedgerTotalsDto,
  MonthKey,
} from '@hostel/shared';
import { feeLedgerQuerySchema } from '@hostel/shared';
import { percent, paiseToRupees } from '../db/money';
import { logger } from '../http/logger';
import {
  dueDateFor,
  effectiveDueDay,
  isEnrolled,
  monthPosition,
  monthTotals,
  type FeeContext,
} from './fee-engine';
import { asFeeResidents, loadRosterWithLedger, type RosterResident } from './roster.service';
import { getFeeContext } from './settings.service';

export type FeeLedgerQuery = z.infer<typeof feeLedgerQuerySchema>;

/**
 * The ledger is one month of one hostel and is deliberately not paginated, but
 * a runaway roster must never become a multi-megabyte response.
 */
export const FEE_LEDGER_ROW_CAP = 1000;

function matchesSearch(resident: RosterResident, search: string | undefined): boolean {
  const term = search?.trim().toLowerCase();
  if (!term) return true;
  return (
    resident.name.toLowerCase().includes(term) ||
    (resident.phone?.toLowerCase().includes(term) ?? false) ||
    resident.building.name.toLowerCase().includes(term)
  );
}

function compareRows(
  sortBy: FeeLedgerQuery['sortBy'],
  sortOrder: FeeLedgerQuery['sortOrder'],
): (a: FeeLedgerRowDto, b: FeeLedgerRowDto) => number {
  const direction = sortOrder === 'desc' ? -1 : 1;
  const byName = (a: FeeLedgerRowDto, b: FeeLedgerRowDto): number =>
    a.residentName.localeCompare(b.residentName);

  return (a, b) => {
    switch (sortBy) {
      case 'balance':
        return (a.balance - b.balance) * direction || byName(a, b);
      case 'expected':
        return (a.expected - b.expected) * direction || byName(a, b);
      case 'paid':
        return (a.paid - b.paid) * direction || byName(a, b);
      case 'dueDate':
        return a.dueDate.localeCompare(b.dueDate) * direction || byName(a, b);
      default:
        return byName(a, b) * direction;
    }
  };
}

function toLedgerRow(
  resident: RosterResident,
  month: MonthKey,
  context: FeeContext,
  position: ReturnType<typeof monthPosition>,
): FeeLedgerRowDto {
  return {
    residentId: resident.id,
    residentName: resident.name,
    phone: resident.phone,
    buildingId: resident.buildingId,
    buildingName: resident.building.name,
    monthlyFee: paiseToRupees(resident.monthlyFee),
    dueDay: effectiveDueDay(resident, context),
    // An enrolled resident always has a due date; the fallback keeps the DTO's
    // non-nullable contract honest without widening it.
    dueDate: position.dueDate ?? dueDateFor(resident, month, context),
    expected: paiseToRupees(position.expected),
    paid: paiseToRupees(position.paid),
    balance: paiseToRupees(position.balance),
    status: position.status,
    daysOverdue: position.daysOverdue,
    paymentCount: position.paymentCount,
  };
}

export async function getFeeLedger(query: FeeLedgerQuery): Promise<FeeLedgerResponseDto> {
  const { context } = await getFeeContext();
  const month = query.month ?? context.currentMonth;

  // Two queries: the roster in scope, and that month's payments for it.
  const { residents, index } = await loadRosterWithLedger(context, {
    buildingId: query.buildingId,
    range: 'month',
    month,
  });

  const matched: RosterResident[] = [];
  const rows: FeeLedgerRowDto[] = [];

  for (const resident of residents) {
    // Someone who joined later or vacated earlier is simply not on this month's
    // ledger - they are not a NOT_STAYING row.
    if (!isEnrolled(resident, month)) continue;

    const position = monthPosition(resident, month, index, context);
    if (!matchesSearch(resident, query.search)) continue;
    if (query.status !== 'all' && position.status !== query.status) continue;

    matched.push(resident);
    rows.push(toLedgerRow(resident, month, context, position));
  }

  // Totals are the engine's, over exactly the rows the screen is showing, so the
  // three stat cards always reconcile with the table beneath them.
  const totals = monthTotals(asFeeResidents(matched), month, index, context);
  const totalsDto: FeeLedgerTotalsDto = {
    residentCount: totals.residentCount,
    expected: paiseToRupees(totals.expected),
    paid: paiseToRupees(totals.paid),
    balance: paiseToRupees(totals.balance),
    collectionRate: percent(totals.paid, totals.expected),
  };

  rows.sort(compareRows(query.sortBy, query.sortOrder));

  if (rows.length > FEE_LEDGER_ROW_CAP) {
    logger.warn('Fee ledger truncated', {
      month,
      buildingId: query.buildingId,
      rowCount: rows.length,
      cap: FEE_LEDGER_ROW_CAP,
    });
    return { month, rows: rows.slice(0, FEE_LEDGER_ROW_CAP), totals: totalsDto };
  }

  return { month, rows, totals: totalsDto };
}
