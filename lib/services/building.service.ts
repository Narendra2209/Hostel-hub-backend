/**
 * The two collections the Settings screen edits: buildings and expense
 * categories.
 *
 * Both are reference data that financial records point at, so the rules here
 * are mostly about *not* destroying history:
 *
 *  * A building is only ever hard-deleted when nothing at all references it -
 *    no residents (archived ones count), no staff, no bills, and no entry in
 *    the resident move history. Otherwise the request is refused with a message
 *    telling the manager exactly what to move first.
 *  * An expense category with bills against it cannot be removed. One that was
 *    used in the past but has no bills left is deactivated rather than deleted,
 *    so the audit trail can still resolve its name. Only a category that was
 *    never used is removed outright.
 *
 * Expense categories live in this file rather than a `category.service.ts`
 * because they are part of the same settings surface: `settings.service.ts`
 * owns the read paths (`listCategories`, `findOrCreateCategory`) and this file
 * owns the writes.
 */
import { z } from 'zod';
import type {
  BuildingDto,
  CreateBuildingInput,
  ExpenseCategoryDto,
  UpdateBuildingInput,
} from '@hostel/shared';
import { createExpenseCategorySchema, updateExpenseCategorySchema } from '@hostel/shared';
import type { Prisma } from '@prisma/client';
import { prisma, type PrismaLike } from '../db/prisma';
import { CACHE_NAMESPACES, getOrLoad, invalidate } from '../cache';
import { buildingNotFound, categoryNotFound, ConflictError } from '../errors/app-error';
import type { AuthContext } from '../auth/context';
import { recordAudit } from './audit.service';
import { getFeeContext, invalidateCategories } from './settings.service';
import { toBuildingDto } from './mappers';
import {
  createBuildingRow,
  deleteBuildingRow,
  findBuildingByCode,
  findBuildingByName,
  findBuildingRow,
  listBuildingRows,
  updateBuildingRow,
  type BuildingRow,
  type BuildingWriteData,
} from '../repositories/building.repository';

export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;
export type UpdateExpenseCategoryInput = z.infer<typeof updateExpenseCategorySchema>;

/** Whether the category list should include deactivated rows (Settings does). */
export const categoryListQuerySchema = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** The outcome of a category removal, so the UI can word its confirmation. */
export interface CategoryRemovalResultDto {
  id: string;
  name: string;
  /** The row was removed outright - it had never been used. */
  deleted: boolean;
  /** The row was kept but deactivated because history still refers to it. */
  deactivated: boolean;
  message: string;
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/* ------------------------------------------------------------------ *
 * Buildings
 * ------------------------------------------------------------------ */

/**
 * `toBuildingDto` derives `deletable` from residents / staff / bills. A move
 * history row is a fourth kind of reference the mapper cannot see, so it is
 * folded in here - otherwise the UI would offer a Remove button the API then
 * refuses.
 */
function toDto(row: BuildingRow): BuildingDto {
  const dto = toBuildingDto({
    ...row.building,
    residentCount: row.stayingResidentCount,
    totalResidentCount: row.totalResidentCount,
    staffCount: row.staffCount,
    expenseCount: row.expenseCount,
  });
  return row.moveHistoryCount > 0 ? { ...dto, deletable: false } : dto;
}

/**
 * A shorter TTL than the settings row, deliberately.
 *
 * The building documents themselves change once a month, but the DTO carries
 * dependent counts - residents, staff, bills, past moves - that move with
 * ordinary business traffic. Those writes live in resident/staff/expense
 * services and do not invalidate this cache, so the TTL is what bounds how
 * stale a count can be. Fifteen seconds still collapses the read storm (a
 * hundred requests a second become one query) while keeping the numbers on the
 * Settings screen recognisably current.
 */
const BUILDING_LIST_TTL_MS = 15_000;

/**
 * Drop the cached building list. Call after the write has COMMITTED.
 *
 * Exported so that a service which changes what the counts would say - moving a
 * resident, filing a bill against a building - can keep the list honest without
 * waiting for the TTL. Nothing outside this file calls it yet; the TTL covers
 * those cases today.
 */
export function invalidateBuildings(): void {
  invalidate(CACHE_NAMESPACES.buildings);
}

/**
 * The building list.
 *
 * Hostel-wide and identical for every caller, which is what makes it safe to
 * share from one cache: there is no per-user filtering here, so no key can leak
 * one user's view to another. Nothing user-scoped or resident-scoped is cached.
 *
 * The key carries the fee context's current month because `stayingResidentCount`
 * is evaluated against it - without that, an entry written in December would
 * still be answering "who is staying" for December after midnight on the 1st of
 * January.
 */
export async function listBuildings(): Promise<BuildingDto[]> {
  const { context } = await getFeeContext();
  const cached = await getOrLoad(
    CACHE_NAMESPACES.buildings,
    `list:${context.currentMonth}`,
    BUILDING_LIST_TTL_MS,
    async () => (await listBuildingRows(context)).map(toDto),
  );
  // A copy: the cached array is shared, and a caller that sorts it in place
  // would reorder it for everyone.
  return [...cached];
}

export async function getBuilding(id: string): Promise<BuildingDto> {
  const { context } = await getFeeContext();
  const row = await findBuildingRow(id, context);
  if (!row) throw buildingNotFound();
  return toDto(row);
}

/** Reject a duplicate name or code before the unique index raises a bare violation. */
async function assertNameAndCodeFree(
  values: { name?: string; code?: string | null },
  excludeId: string | undefined,
  client: PrismaLike,
): Promise<void> {
  if (values.name) {
    const clash = await findBuildingByName(values.name, { excludeId }, client);
    if (clash) throw new ConflictError(`A building called "${clash.name}" already exists.`);
  }
  if (values.code) {
    const clash = await findBuildingByCode(values.code, { excludeId }, client);
    if (clash) throw new ConflictError(`That short code is already used by "${clash.name}".`);
  }
}

export async function createBuilding(
  input: CreateBuildingInput,
  auth: AuthContext,
): Promise<BuildingDto> {
  const created = await prisma.$transaction(async (tx) => {
    await assertNameAndCodeFree({ name: input.name, code: input.code }, undefined, tx);

    const building = await createBuildingRow(
      {
        name: input.name,
        code: input.code ?? null,
        address: input.address ?? null,
        active: input.active,
        sortOrder: input.sortOrder,
      },
      tx,
    );

    await recordAudit(tx, {
      auth,
      action: 'CREATE',
      entityType: 'BUILDING',
      entityId: building.id,
      summary: `Building "${building.name}" added`,
      newData: building,
    });

    return building;
  });

  // After the commit: the cached list is now short one building.
  invalidateBuildings();

  // A building created a moment ago has no dependants; skip the count queries.
  return toDto({
    building: created,
    stayingResidentCount: 0,
    totalResidentCount: 0,
    staffCount: 0,
    expenseCount: 0,
    moveHistoryCount: 0,
  });
}

/**
 * Renaming is the Settings screen's main use. `code` and `address` are cleared
 * by sending an explicit null; an absent key leaves the column untouched.
 */
export async function updateBuilding(
  id: string,
  input: UpdateBuildingInput,
  auth: AuthContext,
): Promise<BuildingDto> {
  const { context } = await getFeeContext();

  await prisma.$transaction(async (tx) => {
    const existing = await tx.building.findUnique({ where: { id } });
    if (!existing) throw buildingNotFound();

    const data: BuildingWriteData = {};
    if (input.name !== undefined) data.name = input.name;
    if ('code' in input) data.code = input.code ?? null;
    if ('address' in input) data.address = input.address ?? null;
    if (input.active !== undefined) data.active = input.active;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

    await assertNameAndCodeFree({ name: data.name, code: data.code }, id, tx);

    const updated = await updateBuildingRow(id, data, tx);

    await recordAudit(tx, {
      auth,
      action: 'UPDATE',
      entityType: 'BUILDING',
      entityId: id,
      summary:
        data.name && data.name !== existing.name
          ? `Building renamed from "${existing.name}" to "${data.name}"`
          : `Building "${existing.name}" updated`,
      oldData: existing,
      newData: updated,
    });
  });

  // After the commit: a rename or a reorder changes the cached list.
  invalidateBuildings();

  const row = await findBuildingRow(id, context);
  if (!row) throw buildingNotFound();
  return toDto(row);
}

/**
 * Remove a building.
 *
 * These four checks are now the ONLY thing standing between a delete and an
 * orphaned reference. MongoDB has no foreign keys and Prisma's referential
 * actions are unavailable on this connector, so nothing below the service layer
 * would refuse the delete: a resident, staff member, bill or move-history row
 * would simply be left pointing at a building id that no longer resolves, and
 * every screen that joins on it would start rendering "Unknown building".
 *
 * The counts are therefore read INSIDE the transaction that performs the
 * delete, from `findBuildingRow`, which counts residents (archived ones
 * included), staff, expenses and both sides of the move history.
 */
export async function deleteBuilding(id: string, auth: AuthContext): Promise<void> {
  const { context } = await getFeeContext();

  await prisma.$transaction(async (tx) => {
    const row = await findBuildingRow(id, context, tx);
    if (!row) throw buildingNotFound();

    if (row.totalResidentCount > 0) {
      throw new ConflictError(
        `Move the ${plural(row.totalResidentCount, 'resident', 'residents')} out of this building first.`,
      );
    }
    if (row.staffCount > 0) {
      throw new ConflictError(
        `Move the ${plural(row.staffCount, 'staff member', 'staff members')} out of this building first.`,
      );
    }
    if (row.expenseCount > 0) {
      throw new ConflictError(
        `Remove the ${plural(row.expenseCount, 'bill', 'bills')} recorded against this building first.`,
      );
    }
    if (row.moveHistoryCount > 0) {
      throw new ConflictError(
        `This building appears in ${plural(
          row.moveHistoryCount,
          'past resident move',
          'past resident moves',
        )} and cannot be removed.`,
      );
    }

    await deleteBuildingRow(id, tx);

    await recordAudit(tx, {
      auth,
      action: 'DELETE',
      entityType: 'BUILDING',
      entityId: id,
      summary: `Building "${row.building.name}" removed`,
      oldData: row.building,
    });
  });

  // After the commit. A cached list that still contains a deleted building is
  // exactly the "Unknown building" failure the guards above exist to prevent.
  invalidateBuildings();
}

/* ------------------------------------------------------------------ *
 * Expense categories
 * ------------------------------------------------------------------ */

const categoryInclude = { _count: { select: { expenses: true } } } as const;

type CategoryWithCount = Prisma.ExpenseCategoryGetPayload<{ include: typeof categoryInclude }>;

const toCategoryDto = (category: CategoryWithCount): ExpenseCategoryDto => ({
  id: category.id,
  slug: category.slug,
  name: category.name,
  active: category.active,
  sortOrder: category.sortOrder,
  expenseCount: category._count.expenses,
});

/**
 * The same rule `settings.service.ts` uses when auto-creating a category from
 * an import, kept in step deliberately: lowercase, non-alphanumerics collapsed
 * to hyphens, trimmed to fit the 60-character column.
 */
const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'category';

/**
 * Derive a slug that is free. One query: every slug sharing the stem is read
 * back and the first unused suffix wins, so adding a second "Water" yields
 * "water-2" without a retry loop against the database.
 */
async function deriveUniqueSlug(name: string, client: PrismaLike): Promise<string> {
  const base = slugify(name);
  // Leave room for a "-999" suffix inside the 60-character column.
  const stem = base.slice(0, 55);
  const rows = await client.expenseCategory.findMany({
    where: { slug: { startsWith: stem } },
    select: { slug: true },
  });
  const taken = new Set(rows.map((row) => row.slug));

  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ConflictError('Too many categories share that name. Try a more specific one.');
}

async function assertCategoryNameFree(
  name: string,
  excludeId: string | undefined,
  client: PrismaLike,
): Promise<void> {
  const clash = await client.expenseCategory.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { name: true },
  });
  if (clash) throw new ConflictError(`A category called "${clash.name}" already exists.`);
}

export async function createCategory(
  input: CreateExpenseCategoryInput,
  auth: AuthContext,
): Promise<ExpenseCategoryDto> {
  const created = await prisma.$transaction(async (tx) => {
    await assertCategoryNameFree(input.name, undefined, tx);
    const slug = await deriveUniqueSlug(input.name, tx);

    const row = await tx.expenseCategory.create({
      data: {
        slug,
        name: input.name,
        sortOrder: input.sortOrder,
        active: input.active,
      },
      include: categoryInclude,
    });

    await recordAudit(tx, {
      auth,
      action: 'CREATE',
      entityType: 'EXPENSE_CATEGORY',
      entityId: row.id,
      summary: `Expense category "${row.name}" added`,
      newData: toCategoryDto(row),
    });

    return toCategoryDto(row);
  });

  // After the commit, or the Settings screen would not show the new category
  // until its cached list expired.
  invalidateCategories();

  return created;
}

/**
 * Rename / reorder / (de)activate a category. The slug is a stable identifier
 * that the default-category bootstrap keys off, so it is deliberately not
 * regenerated when the display name changes.
 */
export async function updateCategory(
  id: string,
  input: UpdateExpenseCategoryInput,
  auth: AuthContext,
): Promise<ExpenseCategoryDto> {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.expenseCategory.findUnique({
      where: { id },
      include: categoryInclude,
    });
    if (!existing) throw categoryNotFound();

    if (input.name !== undefined && input.name !== existing.name) {
      await assertCategoryNameFree(input.name, id, tx);
    }

    const updated = await tx.expenseCategory.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
      include: categoryInclude,
    });

    await recordAudit(tx, {
      auth,
      action: 'UPDATE',
      entityType: 'EXPENSE_CATEGORY',
      entityId: id,
      summary:
        input.name && input.name !== existing.name
          ? `Expense category renamed from "${existing.name}" to "${input.name}"`
          : `Expense category "${existing.name}" updated`,
      oldData: toCategoryDto(existing),
      newData: toCategoryDto(updated),
    });

    return toCategoryDto(updated);
  });

  // After the commit. A rename or a deactivation changes both cached lists -
  // deactivating a category has to remove it from the active-only one.
  invalidateCategories();

  return result;
}

/**
 * Has any bill ever been filed under this category, including ones since
 * deleted? The audit trail is the record of that: every expense mutation stores
 * its `categoryId` in the payload, so one lookup answers it without keeping a
 * counter column that could drift.
 *
 * On PostgreSQL this was a typed `path: ['categoryId']` Json filter. The
 * MongoDB connector has no `path` operator - its Json filters compare whole
 * documents - so the question is asked with a raw aggregation instead. That is
 * a deliberate, contained use of raw access: the alternative is pulling every
 * expense audit payload the hostel has ever written into Lambda memory to scan
 * it here. `aggregate` is one of the commands MongoDB permits inside a
 * transaction, so this still runs under the same snapshot as the delete.
 *
 * `$limit: 1` stops at the first hit; `$project` keeps the document that comes
 * back to a single id.
 */
async function everUsed(id: string, client: PrismaLike): Promise<boolean> {
  const matches: unknown = await client.auditLog.aggregateRaw({
    pipeline: [
      {
        $match: {
          entityType: 'EXPENSE',
          $or: [{ 'newData.categoryId': id }, { 'oldData.categoryId': id }],
        },
      },
      { $limit: 1 },
      { $project: { _id: 1 } },
    ],
  });
  // An aggregation returns its documents as an array; an empty one means the
  // category has never appeared on a bill.
  return Array.isArray(matches) && matches.length > 0;
}

/**
 * Remove a category.
 *
 * Bills against it => refused. Used in the past but empty now => deactivated so
 * the audit trail can still resolve the name. Never used => removed outright.
 */
export async function deleteCategory(
  id: string,
  auth: AuthContext,
): Promise<CategoryRemovalResultDto> {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.expenseCategory.findUnique({
      where: { id },
      include: categoryInclude,
    });
    if (!existing) throw categoryNotFound();

    const expenseCount = existing._count.expenses;
    if (expenseCount > 0) {
      throw new ConflictError(
        `Move the ${plural(expenseCount, 'bill', 'bills')} filed under "${existing.name}" to another category first.`,
      );
    }

    if (await everUsed(id, tx)) {
      const updated = await tx.expenseCategory.update({
        where: { id },
        data: { active: false },
        include: categoryInclude,
      });

      await recordAudit(tx, {
        auth,
        action: 'ARCHIVE',
        entityType: 'EXPENSE_CATEGORY',
        entityId: id,
        summary: `Expense category "${existing.name}" deactivated - past bills reference it`,
        oldData: toCategoryDto(existing),
        newData: toCategoryDto(updated),
      });

      return {
        id,
        name: existing.name,
        deleted: false,
        deactivated: true,
        message: `"${existing.name}" has been used before, so it was hidden rather than deleted. Its history is intact.`,
      };
    }

    await tx.expenseCategory.delete({ where: { id } });

    await recordAudit(tx, {
      auth,
      action: 'DELETE',
      entityType: 'EXPENSE_CATEGORY',
      entityId: id,
      summary: `Expense category "${existing.name}" removed`,
      oldData: toCategoryDto(existing),
    });

    return {
      id,
      name: existing.name,
      deleted: true,
      deactivated: false,
      message: `"${existing.name}" was never used, so it has been removed.`,
    };
  });

  // After the commit, and for both outcomes: a removed category has to leave
  // every cached list, and a deactivated one has to leave the active-only list.
  invalidateCategories();

  return result;
}
