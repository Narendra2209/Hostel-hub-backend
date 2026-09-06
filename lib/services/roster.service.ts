/**
 * Loading a roster together with its payment ledger.
 *
 * This is the query pattern that keeps the dashboard, the fee ledger, the
 * overdue screen and the P&L free of N+1 queries. Whatever the caller needs, it
 * is always **two** queries:
 *
 *   1. the residents in scope
 *   2. every fee payment belonging to those residents in the month range needed
 *
 * The payments are folded into an in-memory index keyed by resident and month,
 * and the fee engine walks that index. A hostel with 200 residents and three
 * years of history is a few thousand rows - trivially cheap - while the
 * alternative (one aggregate query per resident per month) would be tens of
 * thousands of round trips.
 */
import type { MonthKey } from '@hostel/shared';
import { monthKeyToUtcDate, nextMonthKey } from '@hostel/shared';
import type { Prisma } from '@prisma/client';
import { prisma, type PrismaLike } from '../db/prisma';
import {
  buildPaymentIndex,
  earliestJoinMonth,
  type FeeContext,
  type FeeResident,
  type PaymentIndex,
} from './fee-engine';
import { residentBuildingWhere, type BuildingFilter } from '../repositories/filters';

/** Columns the fee engine needs, plus the ones every list renders. */
export const ROSTER_SELECT = {
  id: true,
  name: true,
  phone: true,
  email: true,
  buildingId: true,
  monthlyFee: true,
  dueDay: true,
  joinDate: true,
  vacatedDate: true,
  active: true,
  notes: true,
  photoFileId: true,
  aadhaarFileId: true,
  createdAt: true,
  updatedAt: true,
  building: { select: { id: true, name: true } },
} satisfies Prisma.ResidentSelect;

export type RosterResident = Prisma.ResidentGetPayload<{ select: typeof ROSTER_SELECT }>;

export interface RosterOptions {
  buildingId?: BuildingFilter;
  /** Include archived residents. Defaults to false. */
  includeArchived?: boolean;
  /** Restrict to a specific set of residents. */
  residentIds?: string[];
  /** Extra constraints, merged with the ones above. */
  where?: Prisma.ResidentWhereInput;
}

export function rosterWhere(options: RosterOptions = {}): Prisma.ResidentWhereInput {
  return {
    ...(options.includeArchived ? {} : { active: true }),
    ...(options.buildingId ? residentBuildingWhere(options.buildingId) : {}),
    ...(options.residentIds ? { id: { in: options.residentIds } } : {}),
    ...(options.where ?? {}),
  };
}

export async function loadRoster(
  options: RosterOptions = {},
  client: PrismaLike = prisma,
): Promise<RosterResident[]> {
  return client.resident.findMany({
    where: rosterWhere(options),
    select: ROSTER_SELECT,
    orderBy: { name: 'asc' },
  });
}

export interface RosterWithLedger {
  residents: RosterResident[];
  index: PaymentIndex;
  /** The earliest month covered by the loaded payments. */
  fromMonth: MonthKey | null;
  toMonth: MonthKey;
}

/**
 * Load residents plus the payments needed to evaluate them.
 *
 * `range` controls how far back the payment query reaches:
 *   'month'   - just the one month (fee ledger)
 *   'history' - from the earliest joining month (overdue, dashboard arrears)
 *   'year'    - a calendar year (fee strips)
 */
export async function loadRosterWithLedger(
  context: FeeContext,
  options: RosterOptions & {
    range?: 'month' | 'history' | 'year';
    month?: MonthKey;
    year?: number;
  } = {},
  client: PrismaLike = prisma,
): Promise<RosterWithLedger> {
  const residents = await loadRoster(options, client);
  const toMonth = options.month ?? context.currentMonth;

  if (residents.length === 0) {
    return { residents, index: new Map(), fromMonth: null, toMonth };
  }

  let fromMonth: MonthKey;
  let upperMonth = toMonth;

  switch (options.range ?? 'history') {
    case 'month':
      fromMonth = toMonth;
      break;
    case 'year': {
      const year = options.year ?? Number(context.currentMonth.slice(0, 4));
      fromMonth = `${year}-01`;
      upperMonth = `${year}-12`;
      break;
    }
    default: {
      // Everything from the first joining month up to the month being viewed.
      // A month later than "today" is still honoured so a manager can look
      // ahead, and arrears are always evaluated against the real current month.
      const earliest = earliestJoinMonth(residents as unknown as FeeResident[]);
      fromMonth = earliest ?? toMonth;
      upperMonth = toMonth > context.currentMonth ? toMonth : context.currentMonth;
      break;
    }
  }

  if (fromMonth > upperMonth) fromMonth = upperMonth;

  const payments = await client.feePayment.findMany({
    where: {
      residentId: { in: residents.map((r) => r.id) },
      billingMonth: {
        gte: monthKeyToUtcDate(fromMonth),
        lt: monthKeyToUtcDate(nextMonthKey(upperMonth)),
      },
    },
    select: { residentId: true, billingMonth: true, amount: true },
  });

  return {
    residents,
    index: buildPaymentIndex(payments),
    fromMonth,
    toMonth: upperMonth,
  };
}

/** Adapter: the roster select satisfies the engine's FeeResident shape. */
export const asFeeResident = (resident: RosterResident): FeeResident => resident;

export const asFeeResidents = (residents: RosterResident[]): FeeResident[] => residents;
