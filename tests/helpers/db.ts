/**
 * The integration harness: real MongoDB Atlas, real services, isolated fixtures.
 *
 * These tests run against the same cluster that holds the imported historical
 * register, so NOTHING here may drop a collection, truncate one, or issue an
 * unfiltered `deleteMany`. Isolation comes from *naming* instead: every run
 * mints a `runId` like `test-9f3ac210` and every document it creates carries
 * that prefix in a field the register never uses that way -
 *
 *   buildings.name             `<runId> Block A`
 *   residents.name             `<runId> Alice`
 *   staff.name                 `<runId> Cook`
 *   expenses.referenceNumber   `<runId>`
 *   users.email                `<runId>@integration.test`
 *
 * `Fixtures.tearDown()` deletes exactly those documents, children before
 * parents, resolving ids first rather than filtering through a relation - there
 * are no foreign keys on MongoDB, so the cascade is ours to perform and ours to
 * scope. A finished run leaves the register exactly as it found it.
 *
 * Assertions must never depend on the register: scope every service call to the
 * fixture's own building, its own residents, or a delta measured across the
 * call under test.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';
import type { Prisma } from '@prisma/client';
import type {
  Building,
  Expense,
  ExpenseCategory,
  FeePayment,
  Resident,
  SalaryPayment,
  Staff,
} from '@prisma/client';
import type { MonthKey } from '@hostel/shared';
import {
  currentMonthKey,
  firstDayOfMonth,
  isoDateToUtcDate,
  lastDayOfMonth,
  monthKeyToUtcDate,
  nextMonthKey,
  todayIso,
} from '@hostel/shared';
import type { AuthContext } from '../../lib/auth/context';
import { hashPassword } from '../../lib/auth/password';
import { rupeesToPaise } from '../../lib/db/money';
import { checkDatabaseConnection, prisma, runInTransaction } from '../../lib/db/prisma';

/**
 * `vitest.integration.config.ts` injects `.env.local` into `test.env`, which is
 * the normal path. This is the belt to that pair of braces: it keeps the helper
 * runnable from a bare `vitest` invocation or a one-off script, and it cannot
 * import the config's copy of this loader without dragging Prisma into the
 * config's module graph.
 *
 * Nothing already present in the environment is overwritten, so CI can point
 * the suite at a throwaway cluster without touching the file.
 */
function loadLocalEnv(): void {
  let contents: string;
  try {
    contents = readFileSync(fileURLToPath(new URL('../../.env.local', import.meta.url)), 'utf8');
  } catch {
    return; // No file: the environment is expected to be configured already.
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || key in process.env) continue;
    const value = (rawValue ?? '').trim().replace(/^(['"])(.*)\1$/s, '$2');
    if (value) process.env[key] = value;
  }
}

/**
 * `lib/db/prisma` builds its client on first *use*, not on import, so filling
 * the environment here - after the import graph is evaluated but before any
 * query is issued - is early enough.
 */
if (!process.env.DATABASE_URL) loadLocalEnv();

export { prisma };

/** The connection string with its password blanked, safe to print. */
export function databaseLabel(): string {
  const raw = process.env.DATABASE_URL ?? '(DATABASE_URL is not set)';
  return raw.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
}

/** A single `ping`; false when there is no reachable cluster. */
export const databaseAvailable = (): Promise<boolean> => checkDatabaseConnection();

export const disconnect = (): Promise<void> => prisma.$disconnect();

type SuiteFn = (name: string, fn: () => void) => void;

/**
 * `describe` when Atlas answers, `describe.skip` (with a note) when it does
 * not, so a CI job without a database reports skipped rather than failed.
 */
export async function integrationSuite(): Promise<SuiteFn> {
  if (await databaseAvailable()) return describe;
  console.warn(
    `[integration] No database at ${databaseLabel()} - skipping this suite. ` +
      'Set DATABASE_URL to a reachable MongoDB replica set to run it.',
  );
  return describe.skip;
}

/* ------------------------------------------------------------------ *
 * Small assertions that keep the tests free of non-null assertions
 * ------------------------------------------------------------------ */

export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to exist`);
  return value;
}

/** Narrow a Prisma Json field to an object so a test can read one key. */
export function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  throw new Error(`Expected a JSON object, received ${JSON.stringify(value)}`);
}

/* ------------------------------------------------------------------ *
 * "Now", in the hostel's timezone, exactly as the services resolve it
 * ------------------------------------------------------------------ */

export const today = (): string => todayIso();
export const currentMonth = (): MonthKey => currentMonthKey();
export const monthsAgo = (n: number): MonthKey => nextMonthKey(currentMonthKey(), -n);
export const monthsAhead = (n: number): MonthKey => nextMonthKey(currentMonthKey(), n);

/** A day inside a billing month, for a payment or expense date. */
export const dayIn = (month: MonthKey, day: number): string =>
  `${month}-${String(day).padStart(2, '0')}`;

/* ------------------------------------------------------------------ *
 * Proving that a mutation and its audit row commit together
 * ------------------------------------------------------------------ */

/**
 * Thrown inside a probe transaction, after its writes, to force an abort.
 * Its own type is the signal: anything else escaping the probe is a real
 * failure and is re-thrown untouched.
 */
export class RollbackProbeError extends Error {
  constructor() {
    super('Deliberate failure inside a probe transaction');
    this.name = 'RollbackProbeError';
  }
}

/**
 * Run `writes` inside a real transaction and then make that transaction fail.
 *
 * PostgreSQL stamped every row with `xmin`, so the old suite could prove two
 * rows shared a writing transaction by comparing that id. MongoDB has no such
 * stamp - but the property those tests were reaching for is not "these rows
 * share an id", it is "neither row can exist without the other". This proves
 * that directly and more strongly: both documents are written, the transaction
 * is then aborted, and the caller asserts that NEITHER survives.
 *
 * Returns whatever the callback produced - typically the ids it wrote - so the
 * caller can look for exactly those documents afterwards.
 */
export async function rolledBackTransaction<T>(
  writes: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let written: T | undefined;
  try {
    await runInTransaction(async (tx) => {
      written = await writes(tx);
      throw new RollbackProbeError();
    });
  } catch (error) {
    if (!(error instanceof RollbackProbeError)) throw error;
    return must(written, 'the result of the writes inside the aborted transaction');
  }
  throw new Error('The probe transaction committed; it was supposed to abort.');
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/**
 * Fixture inputs are stated in RUPEES, exactly like a validated request body,
 * and converted to stored paise here - the same boundary the services convert
 * at. Assertions about stored documents are therefore in paise, and assertions
 * about DTOs are in rupees.
 */
export interface ResidentFixtureInput {
  /** Suffix only - the run id is prepended. */
  name: string;
  buildingId: string;
  /** Rupees. */
  monthlyFee: number;
  dueDay: number;
  joinMonth: MonthKey;
  vacatedMonth?: MonthKey | null;
  phone?: string | null;
  active?: boolean;
}

export interface PaymentFixtureInput {
  residentId: string;
  billingMonth: MonthKey;
  /** Rupees. */
  amount: number;
  /** Defaults to the 10th of the billing month. */
  paymentDate?: string;
  note?: string;
}

export interface StaffFixtureInput {
  name: string;
  /** null means a shared cost - somebody who works across the whole hostel. */
  buildingId: string | null;
  /** Rupees. */
  monthlySalary: number;
}

export interface ExpenseFixtureInput {
  /** null means a shared bill nobody attributed to one building. */
  buildingId: string | null;
  date: string;
  /** Rupees. */
  amount: number;
  categoryId?: string;
  vendor?: string;
}

/** Only a run id of exactly this shape may be used as a deletion filter. */
const RUN_ID_PATTERN = /^test-[0-9a-f]{8}$/;

export class Fixtures {
  readonly runId = `test-${randomUUID().slice(0, 8)}`;

  private authContext: AuthContext | null = null;

  /** Makes every fixture building's `code` distinct - see `createBuilding`. */
  private buildingSequence = 0;

  /** The account every service call in the suite is made as. */
  get auth(): AuthContext {
    return must(this.authContext, 'the fixture user (call setUp first)');
  }

  /** Prefix a name so `tearDown` can find it again. */
  label(suffix: string): string {
    return `${this.runId} ${suffix}`;
  }

  async setUp(): Promise<void> {
    const user = await prisma.user.create({
      data: {
        name: this.label('Integration tester'),
        email: `${this.runId}@integration.test`,
        // A random, unrecorded password: the account exists to own audit rows,
        // never to sign in with.
        passwordHash: await hashPassword(randomUUID()),
        role: 'OWNER',
      },
    });
    this.authContext = {
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
      mustChangePassword: user.mustChangePassword,
    };
  }

  /**
   * A building must be given an explicit `code`.
   *
   * `Building.code` is `String? @unique`, and the unique index MongoDB creates
   * for it is neither sparse nor partial - a missing field indexes as null, so
   * the *second* document without a code collides with the first. The register
   * already holds coded buildings, so leaving it null here would fail on the
   * second fixture building of the run. Every fixture therefore carries a code
   * of its own, derived from the run id so `tearDown` still owns it.
   */
  createBuilding(suffix: string): Promise<Building> {
    this.buildingSequence += 1;
    return prisma.building.create({
      data: {
        name: this.label(suffix),
        code: `${this.runId}-b${this.buildingSequence}`,
        sortOrder: 9000,
      },
    });
  }

  createResident(input: ResidentFixtureInput): Promise<Resident> {
    return prisma.resident.create({
      data: {
        name: this.label(input.name),
        phone: input.phone ?? null,
        buildingId: input.buildingId,
        monthlyFee: rupeesToPaise(input.monthlyFee),
        dueDay: input.dueDay,
        joinDate: isoDateToUtcDate(firstDayOfMonth(input.joinMonth)),
        vacatedDate: input.vacatedMonth
          ? isoDateToUtcDate(lastDayOfMonth(input.vacatedMonth))
          : null,
        active: input.active ?? true,
      },
    });
  }

  /** A payment written straight to the ledger, bypassing the service. */
  createPayment(input: PaymentFixtureInput): Promise<FeePayment> {
    return prisma.feePayment.create({
      data: {
        residentId: input.residentId,
        billingMonth: monthKeyToUtcDate(input.billingMonth),
        amount: rupeesToPaise(input.amount),
        paymentDate: isoDateToUtcDate(input.paymentDate ?? dayIn(input.billingMonth, 10)),
        paymentMethod: 'CASH',
        note: input.note ?? null,
        createdById: this.auth.userId,
      },
    });
  }

  createStaff(input: StaffFixtureInput): Promise<Staff> {
    return prisma.staff.create({
      data: {
        name: this.label(input.name),
        buildingId: input.buildingId,
        monthlySalary: rupeesToPaise(input.monthlySalary),
      },
    });
  }

  createSalaryPayment(input: {
    staffId: string;
    salaryMonth: MonthKey;
    /** Rupees. */
    amount: number;
  }): Promise<SalaryPayment> {
    return prisma.salaryPayment.create({
      data: {
        staffId: input.staffId,
        salaryMonth: monthKeyToUtcDate(input.salaryMonth),
        amount: rupeesToPaise(input.amount),
        paymentDate: isoDateToUtcDate(dayIn(input.salaryMonth, 28)),
        createdById: this.auth.userId,
      },
    });
  }

  /** Any existing category will do; the eight defaults are configuration. */
  async anyCategory(): Promise<ExpenseCategory> {
    const category = await prisma.expenseCategory.findFirst({ orderBy: { sortOrder: 'asc' } });
    return must(category, 'at least one expense category');
  }

  async createExpense(input: ExpenseFixtureInput): Promise<Expense> {
    const categoryId = input.categoryId ?? (await this.anyCategory()).id;
    return prisma.expense.create({
      data: {
        date: isoDateToUtcDate(input.date),
        buildingId: input.buildingId,
        categoryId,
        amount: rupeesToPaise(input.amount),
        vendor: input.vendor ?? null,
        // The cleanup handle: a shared expense has no building to find it by.
        referenceNumber: this.runId,
        createdById: this.auth.userId,
      },
    });
  }

  /**
   * Delete exactly what this run created, children before parents.
   *
   * Ids are resolved first and every delete is keyed on them, so no filter can
   * widen to a document the register owns. There is no `onDelete` on MongoDB,
   * so this cascade is performed here in full - which is also why the order
   * below matters.
   */
  async tearDown(): Promise<void> {
    if (!RUN_ID_PATTERN.test(this.runId)) {
      throw new Error(`Refusing to delete with an unrecognised run id: ${this.runId}`);
    }
    const owned = { name: { startsWith: this.runId } };
    const userId = this.authContext?.userId;

    const residentIds = (
      await prisma.resident.findMany({ where: owned, select: { id: true } })
    ).map((row) => row.id);
    const staffIds = (await prisma.staff.findMany({ where: owned, select: { id: true } })).map(
      (row) => row.id,
    );

    // Every service call in these suites is made as the fixture user, so this
    // is precisely the audit rows the run wrote.
    if (userId) await prisma.auditLog.deleteMany({ where: { userId } });
    if (residentIds.length > 0) {
      await prisma.feePayment.deleteMany({ where: { residentId: { in: residentIds } } });
      await prisma.residentBuildingHistory.deleteMany({
        where: { residentId: { in: residentIds } },
      });
      await prisma.resident.deleteMany({ where: { id: { in: residentIds } } });
    }
    if (staffIds.length > 0) {
      await prisma.salaryPayment.deleteMany({ where: { staffId: { in: staffIds } } });
      await prisma.staff.deleteMany({ where: { id: { in: staffIds } } });
    }
    await prisma.expense.deleteMany({ where: { referenceNumber: this.runId } });
    await prisma.building.deleteMany({ where: owned });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });

    this.authContext = null;
  }
}
