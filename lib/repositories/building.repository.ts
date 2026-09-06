/**
 * Building queries.
 *
 * The Settings screen lists every building next to how many records depend on
 * it, and the dashboard needs the same numbers. That is deliberately **two**
 * queries for the entire list - Prisma's `_count` for the dependent relations
 * plus one grouped count for "staying right now" - never one query per
 * building.
 *
 * "Staying right now" is not the same as "has a resident row": a resident who
 * vacated in a previous month is still attached to the building (their payment
 * history must survive) but no longer occupies a bed. The window is evaluated
 * against the fee context's current month so every screen agrees on what
 * "now" means.
 */
import type { Building, Prisma } from '@prisma/client';
import { firstDayOfMonth, isoDateToUtcDate } from '@hostel/shared';
import { prisma, type PrismaLike } from '../db/prisma';
import type { FeeContext } from '../services/fee-engine';

/** A building plus every count the DTO and the delete guard need. */
export interface BuildingRow {
  building: Building;
  /** Active residents whose stay has not ended before the current month. */
  stayingResidentCount: number;
  /** Every resident row attached to the building - vacated and archived included. */
  totalResidentCount: number;
  staffCount: number;
  expenseCount: number;
  /** Move-history rows referencing this building on either side. */
  moveHistoryCount: number;
}

/** Fields a caller may write. `null` clears a nullable column. */
export interface BuildingWriteData {
  name?: string;
  code?: string | null;
  address?: string | null;
  active?: boolean;
  sortOrder?: number;
}

/**
 * Every relation that would be orphaned by a hard delete. `movesFrom` /
 * `movesTo` matter because a resident who moved away leaves a history row
 * pointing back at the old building even though they no longer live in it.
 */
const dependentCounts = {
  residents: true,
  staff: true,
  expenses: true,
  movesFrom: true,
  movesTo: true,
} as const;

type BuildingWithCountRow = Building & {
  _count: {
    residents: number;
    staff: number;
    expenses: number;
    movesFrom: number;
    movesTo: number;
  };
};

/** Residents occupying a bed as of the context's current month. */
export function stayingResidentWhere(context: FeeContext): Prisma.ResidentWhereInput {
  const firstOfCurrentMonth = isoDateToUtcDate(firstDayOfMonth(context.currentMonth));
  return {
    active: true,
    OR: [{ vacatedDate: null }, { vacatedDate: { gte: firstOfCurrentMonth } }],
  };
}

function toRow(building: BuildingWithCountRow, stayingResidentCount: number): BuildingRow {
  const { _count, ...rest } = building;
  return {
    building: rest,
    stayingResidentCount,
    totalResidentCount: _count.residents,
    staffCount: _count.staff,
    expenseCount: _count.expenses,
    moveHistoryCount: _count.movesFrom + _count.movesTo,
  };
}

/** Every building, ordered the way the UI renders them. Two queries, always. */
export async function listBuildingRows(
  context: FeeContext,
  client: PrismaLike = prisma,
): Promise<BuildingRow[]> {
  const [buildings, stayingGroups] = await Promise.all([
    client.building.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: dependentCounts } },
    }),
    client.resident.groupBy({
      by: ['buildingId'],
      where: stayingResidentWhere(context),
      _count: { _all: true },
    }),
  ]);

  const stayingByBuilding = new Map<string, number>(
    stayingGroups.map((group) => [group.buildingId, group._count._all]),
  );

  return buildings.map((building) => toRow(building, stayingByBuilding.get(building.id) ?? 0));
}

/** One building with the same counts, or null when the id does not exist. */
export async function findBuildingRow(
  id: string,
  context: FeeContext,
  client: PrismaLike = prisma,
): Promise<BuildingRow | null> {
  const building = await client.building.findUnique({
    where: { id },
    include: { _count: { select: dependentCounts } },
  });
  if (!building) return null;

  const stayingResidentCount = await client.resident.count({
    where: { ...stayingResidentWhere(context), buildingId: id },
  });
  return toRow(building, stayingResidentCount);
}

/**
 * Name and code are unique columns. These lookups are case-insensitive so the
 * API rejects "Sunrise" vs "sunrise" with a readable message instead of letting
 * PostgreSQL raise a bare unique-violation.
 */
export async function findBuildingByName(
  name: string,
  options: { excludeId?: string } = {},
  client: PrismaLike = prisma,
): Promise<{ id: string; name: string } | null> {
  return client.building.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(options.excludeId ? { id: { not: options.excludeId } } : {}),
    },
    select: { id: true, name: true },
  });
}

export async function findBuildingByCode(
  code: string,
  options: { excludeId?: string } = {},
  client: PrismaLike = prisma,
): Promise<{ id: string; name: string } | null> {
  return client.building.findFirst({
    where: {
      code: { equals: code, mode: 'insensitive' },
      ...(options.excludeId ? { id: { not: options.excludeId } } : {}),
    },
    select: { id: true, name: true },
  });
}

export async function createBuildingRow(
  data: BuildingWriteData & { name: string },
  client: PrismaLike = prisma,
): Promise<Building> {
  return client.building.create({ data });
}

export async function updateBuildingRow(
  id: string,
  data: BuildingWriteData,
  client: PrismaLike = prisma,
): Promise<Building> {
  return client.building.update({ where: { id }, data });
}

/**
 * Hard delete. Only ever called once the service has proved nothing references
 * the building - a building with financial history is never removed.
 */
export async function deleteBuildingRow(id: string, client: PrismaLike = prisma): Promise<void> {
  await client.building.delete({ where: { id } });
}
