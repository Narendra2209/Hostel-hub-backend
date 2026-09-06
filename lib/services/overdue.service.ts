/**
 * The overdue screen.
 *
 * Every figure the screen renders - the three stat cards, the "every unpaid
 * month, past due date" table, and the dashboard's "who owes money" card - is
 * derived from a SINGLE roster load:
 *
 *   loadRosterWithLedger({ range: 'history' })  ->  residents + payment index
 *   residentArrears(resident, index, context)   ->  the unpaid months
 *
 * That is two queries no matter how many residents exist. Nothing in this file
 * queries inside a loop, and no due date, balance or status is re-derived here:
 * the fee engine owns all of it.
 *
 * Sorting and pagination happen in memory, deliberately. The overdue set is the
 * unpaid subset of an already small roster, and the rows only come into
 * existence after the engine has walked each resident's billing history - there
 * is no database-side ordering that could have produced them.
 */
import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import type {
  MonthKey,
  OverdueResidentDto,
  OverdueRowDto,
  OverdueTotalsDto,
  overdueQuerySchema,
} from '@hostel/shared';
import { paiseToRupees, ZERO, type Paise } from '../db/money';
import { prisma, type PrismaLike } from '../db/prisma';
import { searchFilter } from '../repositories/filters';
import { isStaying, residentArrears, type FeeContext, type PaymentIndex } from './fee-engine';
import { loadRosterWithLedger, type RosterResident } from './roster.service';
import { getFeeContext } from './settings.service';

export type OverdueQuery = z.infer<typeof overdueQuerySchema>;

/** Mirrors the mappers' fallback for a resident whose building row is missing. */
const UNASSIGNED_BUILDING = 'Unassigned';

/**
 * Everything the overdue screen and the dashboard need, computed once.
 *
 * `residents` is ordered by amount owed, largest first, so the dashboard can
 * take the top slice without re-sorting. The paise members exist so the
 * dashboard can keep doing its column arithmetic on exact integers instead of
 * adding up the already-rounded rupee numbers carried by the DTOs.
 */
export interface OverdueSnapshot {
  /** One row per unpaid, past-due billing month. */
  rows: OverdueRowDto[];
  /** One row per resident who owes something, largest debt first. */
  residents: OverdueResidentDto[];
  totals: OverdueTotalsDto;
  /** Arrears across every resident in scope, in PAISE. */
  totalOverdue: Paise;
  /** buildingId -> arrears owed by that building's residents, in PAISE. */
  overdueByBuilding: Map<string, Paise>;
}

const compareMonths = (a: MonthKey, b: MonthKey): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Fold a loaded roster into overdue rows, per-resident totals and the headline
 * totals. Pure and synchronous - the caller owns the queries.
 */
export function buildOverdueSnapshot(
  residents: RosterResident[],
  index: PaymentIndex,
  context: FeeContext,
): OverdueSnapshot {
  const rows: OverdueRowDto[] = [];
  const residentRows: OverdueResidentDto[] = [];
  const overdueByBuilding = new Map<string, Paise>();

  let totalOverdue: Paise = ZERO;
  let stayingResidentCount = 0;
  let oldestDaysOverdue = 0;
  let oldestResidentName: string | null = null;

  for (const resident of residents) {
    if (isStaying(resident, context)) stayingResidentCount += 1;

    const arrears = residentArrears(resident, index, context);
    if (arrears.overdueMonths.length === 0) continue;

    const buildingName = resident.building?.name ?? UNASSIGNED_BUILDING;

    for (const unpaid of arrears.overdueMonths) {
      rows.push({
        residentId: resident.id,
        residentName: resident.name,
        phone: resident.phone,
        buildingId: resident.buildingId,
        buildingName,
        month: unpaid.month,
        expected: paiseToRupees(unpaid.expected),
        paid: paiseToRupees(unpaid.paid),
        balance: paiseToRupees(unpaid.balance),
        dueDate: unpaid.dueDate,
        daysOverdue: unpaid.daysOverdue,
      });
    }

    residentRows.push({
      residentId: resident.id,
      residentName: resident.name,
      phone: resident.phone,
      buildingId: resident.buildingId,
      buildingName,
      totalOverdue: paiseToRupees(arrears.totalOverdue),
      oldestUnpaidMonth: arrears.oldestUnpaidMonth,
      numberOfOverdueMonths: arrears.overdueMonths.length,
      maxDaysOverdue: arrears.maxDaysOverdue,
    });

    totalOverdue += arrears.totalOverdue;
    overdueByBuilding.set(
      resident.buildingId,
      (overdueByBuilding.get(resident.buildingId) ?? ZERO) + arrears.totalOverdue,
    );

    // The roster arrives name-ascending, so a tie for "oldest" resolves to the
    // first name alphabetically and the card never flickers between requests.
    if (arrears.maxDaysOverdue > oldestDaysOverdue) {
      oldestDaysOverdue = arrears.maxDaysOverdue;
      oldestResidentName = resident.name;
    }
  }

  residentRows.sort(
    (a, b) => b.totalOverdue - a.totalOverdue || a.residentName.localeCompare(b.residentName),
  );

  return {
    rows,
    residents: residentRows,
    totals: {
      totalOverdue: paiseToRupees(totalOverdue),
      overdueMonthCount: rows.length,
      residentCount: residentRows.length,
      stayingResidentCount,
      oldestDaysOverdue,
      oldestResidentName,
    },
    totalOverdue,
    overdueByBuilding,
  };
}

/* ------------------------------------------------------------------ *
 * Sorting
 * ------------------------------------------------------------------ */

function sortRows(
  rows: OverdueRowDto[],
  sortBy: OverdueQuery['sortBy'],
  sortOrder: OverdueQuery['sortOrder'],
): OverdueRowDto[] {
  const direction = sortOrder === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let primary: number;
    switch (sortBy) {
      case 'balance':
        primary = a.balance - b.balance;
        break;
      case 'name':
        primary = a.residentName.localeCompare(b.residentName);
        break;
      case 'month':
        primary = compareMonths(a.month, b.month);
        break;
      default:
        primary = a.daysOverdue - b.daysOverdue;
        break;
    }
    if (primary !== 0) return primary * direction;
    // Stable, human-sensible tie-break: the same person's months stay together.
    return a.residentName.localeCompare(b.residentName) || compareMonths(a.month, b.month);
  });
}

function sortResidents(
  residents: OverdueResidentDto[],
  sortBy: OverdueQuery['sortBy'],
  sortOrder: OverdueQuery['sortOrder'],
): OverdueResidentDto[] {
  const direction = sortOrder === 'asc' ? 1 : -1;
  return [...residents].sort((a, b) => {
    let primary: number;
    switch (sortBy) {
      case 'balance':
        primary = a.totalOverdue - b.totalOverdue;
        break;
      case 'name':
        primary = a.residentName.localeCompare(b.residentName);
        break;
      case 'month':
        primary = compareMonths(a.oldestUnpaidMonth ?? '', b.oldestUnpaidMonth ?? '');
        break;
      default:
        primary = a.maxDaysOverdue - b.maxDaysOverdue;
        break;
    }
    if (primary !== 0) return primary * direction;
    return a.residentName.localeCompare(b.residentName);
  });
}

/* ------------------------------------------------------------------ *
 * The endpoint
 * ------------------------------------------------------------------ */

export interface OverdueResult {
  /**
   * One page of rows. Every element is an `OverdueRowDto` when `groupBy` is
   * "month" and an `OverdueResidentDto` when it is "resident" - the array is
   * never mixed, the caller already knows which mode it asked for.
   */
  items: Array<OverdueRowDto | OverdueResidentDto>;
  /** Row count before pagination, for the pagination meta. */
  total: number;
  totals: OverdueTotalsDto;
}

/**
 * Restrict the roster by the search box in the query, so the table, the stat cards
 * and the pagination all describe exactly the same set of people.
 */
function residentSearchWhere(search?: string): Prisma.ResidentWhereInput | undefined {
  const filter = searchFilter(search);
  if (!filter) return undefined;
  return { OR: [{ name: filter }, { phone: filter }] };
}

/**
 * Load the overdue set for one building filter, then sort and paginate it.
 *
 * Two queries via `loadRosterWithLedger`, plus the settings read that resolves
 * "today" - a constant, whatever the size of the hostel.
 */
export async function getOverdue(
  query: OverdueQuery,
  client: PrismaLike = prisma,
): Promise<OverdueResult> {
  const { context } = await getFeeContext(client);

  const { residents, index } = await loadRosterWithLedger(
    context,
    {
      buildingId: query.buildingId,
      range: 'history',
      where: residentSearchWhere(query.search),
    },
    client,
  );

  const snapshot = buildOverdueSnapshot(residents, index, context);

  const sorted: OverdueRowDto[] | OverdueResidentDto[] =
    query.groupBy === 'resident'
      ? sortResidents(snapshot.residents, query.sortBy, query.sortOrder)
      : sortRows(snapshot.rows, query.sortBy, query.sortOrder);

  const start = (query.page - 1) * query.pageSize;

  return {
    items: sorted.slice(start, start + query.pageSize),
    total: sorted.length,
    totals: snapshot.totals,
  };
}
