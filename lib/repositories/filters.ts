/**
 * Shared query filters.
 *
 * The building filter has three meanings across every screen and they must be
 * interpreted identically everywhere:
 *   "all"     -> no constraint
 *   "shared"  -> records with no building attached (expenses / staff only)
 *   "<uuid>"  -> that building
 */
import type { Prisma } from '@prisma/client';
import type { MonthKey } from '@hostel/shared';
import { ALL_BUILDINGS, SHARED_BUILDING, firstDayOfMonth, isoDateToUtcDate, monthKeyToUtcDate, nextMonthKey } from '@hostel/shared';

export type BuildingFilter = string; // 'all' | 'shared' | uuid

export const isAllBuildings = (filter: BuildingFilter): boolean => filter === ALL_BUILDINGS;
export const isSharedOnly = (filter: BuildingFilter): boolean => filter === SHARED_BUILDING;
export const isSpecificBuilding = (filter: BuildingFilter): boolean =>
  !isAllBuildings(filter) && !isSharedOnly(filter);

/** For entities whose buildingId is NOT NULL (residents). */
export function residentBuildingWhere(filter: BuildingFilter): Prisma.ResidentWhereInput {
  if (isAllBuildings(filter)) return {};
  /*
   * A resident always belongs to a building, so "shared" must match nothing.
   *
   * Two wrong ways to say that, both of which were tried:
   *   - a UUID-shaped sentinel id makes Prisma raise P2023 "Malformed ObjectID"
   *     on MongoDB, turning an empty list into a 500;
   *   - `NOT: {}` negates an empty condition, which Prisma treats as no
   *     constraint at all, so it silently matches EVERY resident - worse,
   *     because it returns wrong numbers instead of failing.
   *
   * An empty `in` list is unambiguous: it compiles to `{_id: {$in: []}}`,
   * matches nothing, and invents no id.
   */
  if (isSharedOnly(filter)) return { id: { in: [] } };
  return { buildingId: filter };
}

/** For entities whose buildingId is nullable (expenses, staff). */
export function nullableBuildingWhere(
  filter: BuildingFilter,
): { buildingId?: string | null } {
  if (isAllBuildings(filter)) return {};
  if (isSharedOnly(filter)) return { buildingId: null };
  return { buildingId: filter };
}

/**
 * Half-open date range covering one billing month: `>= first` and `< nextFirst`.
 * Used for DATE columns so an index range scan is possible.
 */
export function monthDateRange(month: MonthKey): { gte: Date; lt: Date } {
  return { gte: monthKeyToUtcDate(month), lt: monthKeyToUtcDate(nextMonthKey(month)) };
}

/** Half-open range spanning `from`..`to` inclusive of both months. */
export function monthSpanRange(from: MonthKey, to: MonthKey): { gte: Date; lt: Date } {
  return { gte: monthKeyToUtcDate(from), lt: monthKeyToUtcDate(nextMonthKey(to)) };
}

/** Optional calendar-date range for list filters. */
export function dateRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: isoDateToUtcDate(from) } : {}),
    ...(to ? { lte: isoDateToUtcDate(to) } : {}),
  };
}

/**
 * Escape every regular-expression metacharacter in a search term.
 *
 * Prisma's MongoDB connector compiles `contains` into `$regexMatch` and passes
 * the string through UNESCAPED, so whatever a user types in a search box is
 * evaluated as a pattern by the database. Two consequences, both reachable by
 * any signed-in user:
 *
 *   - Searching for a name containing a bracket - "Owner) signed" - is not a
 *     valid regex, and MongoDB fails the query with error 51111. The user sees
 *     a 500 for typing an ordinary character.
 *   - A pattern such as `(a+)+$` backtracks catastrophically, and it does so
 *     inside the database server, on every scanned document. That is a
 *     denial-of-service anyone with a login can trigger from a text box.
 *
 * Escaping makes the term mean exactly what was typed, which is also what a
 * user expects a search box to do.
 */
export const escapeRegExp = (term: string): string =>
  term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive contains filter, or undefined when the search box is empty. */
export function searchFilter(search?: string): Prisma.StringFilter | undefined {
  const term = search?.trim();
  if (!term) return undefined;
  return { contains: escapeRegExp(term), mode: 'insensitive' };
}

/** The first day of a month as a Date, for writing a billingMonth column. */
export const billingMonthValue = (month: MonthKey): Date =>
  isoDateToUtcDate(firstDayOfMonth(month));
