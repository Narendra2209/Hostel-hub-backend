/**
 * Hostel settings and expense categories.
 *
 * Both are *configuration*, not business data, so both are bootstrapped
 * idempotently on first read. That is what lets the application run correctly
 * against a freshly migrated, completely empty database without the seed script
 * ever having been run. Buildings and residents are deliberately NOT
 * bootstrapped - those are real business records the user must enter.
 *
 * Caching
 * -------
 * Both are read on nearly every request - `getFeeContext` needs the settings
 * row before any financial query can run, and every expense path checks that
 * the categories exist - and both change perhaps once a month. They are
 * therefore served from the in-process TTL cache in lib/cache.
 *
 * Both are hostel-wide: every signed-in user sees exactly the same settings row
 * and the same category list, which is what makes them safe to share between
 * callers. Nothing user-scoped or resident-scoped is cached anywhere in this
 * file, and nothing that depends on who is asking ever should be.
 *
 * Every write below invalidates. An owner who changes the due day and does not
 * see it take effect is a worse bug than the redundant reads the cache removes,
 * so the invalidation - not the caching - is the part to be careful with.
 */
import type { ExpenseCategoryDto, SettingsDto, UpdateSettingsInput } from '@hostel/shared';
import {
  DEFAULT_CURRENCY_CODE,
  DEFAULT_CURRENCY_SYMBOL,
  DEFAULT_DUE_DAY,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_HOSTEL_NAME,
  APP_TIMEZONE,
} from '@hostel/shared';
import type { HostelSettings } from '@prisma/client';
import { prisma, type PrismaLike } from '../db/prisma';
import { CACHE_NAMESPACES, getOrLoad, invalidate } from '../cache';
import { recordAudit } from './audit.service';
import type { AuthContext } from '../auth/context';
import { createFeeContext, type FeeContext } from './fee-engine';

/**
 * A minute is long enough to collapse the read storm a busy hostel generates
 * and short enough that a second container picks up a settings change before
 * anyone reports it as broken. The container that served the write sees it
 * immediately, because the write invalidates.
 */
const SETTINGS_TTL_MS = 60_000;
const CATEGORY_LIST_TTL_MS = 60_000;

/**
 * "The default categories exist" is a one-way fact for a given database, so it
 * is held longer than the lists. Any category write invalidates the whole
 * namespace, including this flag, which costs one extra `count` afterwards.
 */
const CATEGORY_BOOTSTRAP_TTL_MS = 5 * 60_000;

const SETTINGS_KEY = 'singleton';
const CATEGORY_BOOTSTRAP_KEY = 'bootstrapped';

/** Drop the cached settings row. Call after the write has COMMITTED. */
export function invalidateSettings(): void {
  invalidate(CACHE_NAMESPACES.settings);
}

/**
 * Drop the cached category lists and the bootstrap flag. Call after the write
 * has COMMITTED. Exported because building.service.ts owns the category write
 * paths; the cache keys stay owned here.
 */
export function invalidateCategories(): void {
  invalidate(CACHE_NAMESPACES.categories);
}

export function toSettingsDto(settings: HostelSettings): SettingsDto {
  return {
    id: settings.id,
    hostelName: settings.hostelName,
    currency: settings.currency,
    currencyCode: settings.currencyCode,
    defaultDueDay: settings.defaultDueDay,
    timezone: settings.timezone,
    updatedAt: settings.updatedAt.toISOString(),
  };
}

/**
 * The one settings row, created on first access.
 * `singleton` is a unique column, so a race between two cold Lambdas resolves
 * to a single row rather than duplicates.
 */
async function loadSettings(client: PrismaLike): Promise<HostelSettings> {
  const existing = await client.hostelSettings.findFirst();
  if (existing) return existing;

  try {
    return await client.hostelSettings.create({
      data: {
        singleton: true,
        hostelName: DEFAULT_HOSTEL_NAME,
        currency: DEFAULT_CURRENCY_SYMBOL,
        currencyCode: DEFAULT_CURRENCY_CODE,
        defaultDueDay: DEFAULT_DUE_DAY,
        timezone: APP_TIMEZONE,
      },
    });
  } catch {
    // Lost the race - the other writer's row is the one we want.
    const row = await client.hostelSettings.findFirst();
    if (row) return row;
    throw new Error('Could not initialise hostel settings');
  }
}

/**
 * The settings row, cached for a minute.
 *
 * The cache is bypassed entirely when a transaction client is passed. Inside a
 * transaction the caller wants the row under that transaction's own snapshot -
 * `user.service.serialiseAccountChange` reads it and then writes it back as the
 * lock that serialises account changes - and a row read inside a transaction
 * that may still roll back must never be published to other callers.
 *
 * Callers share one object. Nothing mutates a settings row in place; treat what
 * comes back as read-only.
 */
export async function getSettings(client: PrismaLike = prisma): Promise<HostelSettings> {
  if (client !== prisma) return loadSettings(client);
  return getOrLoad(CACHE_NAMESPACES.settings, SETTINGS_KEY, SETTINGS_TTL_MS, () =>
    loadSettings(prisma),
  );
}

/**
 * Settings plus a resolved "today", the context every financial query needs.
 *
 * Only the settings row is cached. The context itself is rebuilt on every call
 * because it resolves the current date in the hostel's timezone - caching it
 * would freeze "today" for the life of the entry and quietly move every due
 * date and overdue calculation off by a day across midnight.
 */
export async function getFeeContext(client: PrismaLike = prisma): Promise<{
  settings: HostelSettings;
  context: FeeContext;
}> {
  const settings = await getSettings(client);
  return { settings, context: createFeeContext(settings) };
}

export async function updateSettings(
  input: UpdateSettingsInput,
  auth: AuthContext,
): Promise<HostelSettings> {
  const current = await getSettings();

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.hostelSettings.update({
      where: { id: current.id },
      data: {
        ...(input.hostelName !== undefined ? { hostelName: input.hostelName } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.currencyCode !== undefined ? { currencyCode: input.currencyCode } : {}),
        ...(input.defaultDueDay !== undefined ? { defaultDueDay: input.defaultDueDay } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      },
    });

    await recordAudit(tx, {
      auth,
      action: 'UPDATE',
      entityType: 'SETTINGS',
      entityId: row.id,
      summary: 'Hostel settings updated',
      oldData: toSettingsDto(current),
      newData: toSettingsDto(row),
    });

    return row;
  });

  /*
   * After the commit, never before it. Dropping the entry while the transaction
   * is still open lets a concurrent read reload the PRE-write row and cache it
   * for a full TTL - the owner would change the due day, the API would report
   * success, and the new value would not take effect. Invalidating here also
   * disqualifies any read still in flight from publishing what it read.
   */
  invalidateSettings();

  return updated;
}

/* ------------------------------------------------------------------ *
 * Expense categories
 * ------------------------------------------------------------------ */

/**
 * Create the default categories if the collection is empty.
 *
 * `skipDuplicates` is a PostgreSQL-only option, so a race between two cold
 * starts is handled by catching the unique-index violation instead: whichever
 * writer loses simply finds the other's documents already there.
 */
async function bootstrapCategories(client: PrismaLike): Promise<void> {
  const count = await client.expenseCategory.count();
  if (count > 0) return;
  try {
    await client.expenseCategory.createMany({
      data: DEFAULT_EXPENSE_CATEGORIES.map((category) => ({ ...category })),
    });
  } catch {
    // Another request bootstrapped them first - nothing to do.
  }
}

/**
 * Make sure the default categories exist.
 *
 * This used to be a `count()` on EVERY request that touched an expense, which
 * at 1000 signed-in staff is a query per request to answer a question whose
 * answer changed once, when the database was first used. The result is cached
 * as a flag; any category write drops it along with the lists.
 */
export async function ensureDefaultCategories(client: PrismaLike = prisma): Promise<void> {
  if (client !== prisma) {
    await bootstrapCategories(client);
    return;
  }
  await getOrLoad(
    CACHE_NAMESPACES.categories,
    CATEGORY_BOOTSTRAP_KEY,
    CATEGORY_BOOTSTRAP_TTL_MS,
    async () => {
      await bootstrapCategories(prisma);
      return true;
    },
  );
}

async function loadCategories(includeInactive: boolean): Promise<ExpenseCategoryDto[]> {
  await ensureDefaultCategories();
  const categories = await prisma.expenseCategory.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { expenses: true } } },
  });
  return categories.map((category) => ({
    id: category.id,
    slug: category.slug,
    name: category.name,
    active: category.active,
    sortOrder: category.sortOrder,
    expenseCount: category._count.expenses,
  }));
}

/**
 * The category list, cached for a minute under one key per list shape.
 *
 * `expenseCount` is the one field here that moves with ordinary business
 * traffic rather than with a category write, so a bill filed in the last minute
 * may not be reflected in the count yet. That is a display figure only: nothing
 * decides anything from it. `deleteCategory` re-reads the real count inside its
 * own transaction, so a stale count can never let a category with bills against
 * it be removed.
 */
export async function listCategories(
  options: { includeInactive?: boolean } = {},
): Promise<ExpenseCategoryDto[]> {
  const includeInactive = options.includeInactive === true;
  const cached = await getOrLoad(
    CACHE_NAMESPACES.categories,
    includeInactive ? 'list:all' : 'list:active',
    CATEGORY_LIST_TTL_MS,
    () => loadCategories(includeInactive),
  );
  // A copy, so a caller that sorts or splices the result cannot corrupt the
  // array every other caller is about to be handed.
  return [...cached];
}

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'category';

/** Find a category by name, creating it when it does not exist (used by imports). */
export async function findOrCreateCategory(
  name: string,
  client: PrismaLike = prisma,
): Promise<{ id: string; name: string }> {
  const slug = slugify(name);
  const existing = await client.expenseCategory.findFirst({
    where: { OR: [{ slug }, { name }] },
  });
  if (existing) return { id: existing.id, name: existing.name };
  const created = await client.expenseCategory.create({
    data: { slug, name: name.trim().slice(0, 80), sortOrder: 500 },
  });
  // A row was added, so any cached list is now short one category.
  invalidateCategories();
  return { id: created.id, name: created.name };
}
