/**
 * ONE-SHOT IMPORT OF THE LEGACY REGISTER.
 *
 * WHAT THIS IS
 * ------------
 * The original Hostel Manager was a single HTML file whose August 2026 register
 * - residents, fees, payments, staff salaries and the month's running costs -
 * was hardcoded in JavaScript arrays. That is *historical business data*, not
 * application code, so it has been lifted out into `scripts/legacy-data.json`
 * and is loaded into MongoDB exactly once by this script.
 *
 * AFTER THE IMPORT THE DATA LIVES IN THE DATABASE. Nothing in `app/` or `lib/`
 * may ever read that file, import this module, or reference any name, fee or
 * amount inside it. The API must - and does - work perfectly against a freshly
 * migrated, completely empty database: settings and expense categories are
 * bootstrapped on first read and every other number is a query result. This
 * import is a convenience for the owner migrating off the old page, and for
 * nobody else.
 *
 * MONEY
 * -----
 * The register is written in RUPEES, because that is what the old page showed.
 * The database stores integer PAISE, so every amount crosses `rupeesToPaise()`
 * on the way in: a 4,500-rupee rent is written as 450000. The idempotency keys
 * below normalise BOTH sides to paise before comparing, because a stored 450000
 * and a source 4500 are the same money and must match on a re-run.
 *
 * PROPERTIES
 * ----------
 *  * Idempotent. Buildings match on name, residents on (name + building), fee
 *    payments on (resident + billing month + amount + payment date), staff on
 *    name, salary payments on (staff + salary month + amount + payment date)
 *    and expenses on (date + amount + note), with every amount compared in
 *    paise. Anything already present is counted as skipped, never duplicated -
 *    so a second run is a no-op and a half-finished run can simply be repeated.
 *  * Transactional per entity type. Buildings, residents, fee payments, staff,
 *    salary payments and expenses are each imported inside their own
 *    transaction, together with the audit rows describing them. PostgreSQL held
 *    the whole register in a single transaction; MongoDB aborts any transaction
 *    older than sixty seconds server-side, and this register is several hundred
 *    sequential inserts once every row's audit entry is counted, so wrapping all
 *    of it in one transaction would be a bet against the clock rather than a
 *    guarantee. Each phase is still all-or-nothing, and idempotency is what
 *    recovers a failure in a later phase: re-run, and the phases that already
 *    committed are skipped.
 *  * Audited. Each created row gets an audit entry in the same transaction,
 *    attributed to no human user, so the trail says "arrived via the legacy
 *    import" forever. Audit payloads quote rupees, matching the DTOs the rest
 *    of the audit trail is built from.
 *  * Refuses to run when NODE_ENV is production unless --allow-production.
 *
 * USAGE
 * -----
 *   npm run import:legacy                  # from apps/api or the repo root
 *   npm run import:legacy -- --dry-run     # validate the file, touch nothing
 *   npm run import:legacy -- --file=/path/to/register.json
 *   npm run import:legacy -- --allow-production
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  firstDayOfMonth,
  isIsoDate,
  isMonthKey,
  isoDateToUtcDate,
  lastDayOfMonth,
  monthKeyToUtcDate,
  utcDateToIsoDate,
  utcDateToMonthKey,
} from '@hostel/shared';
import type { Prisma } from '@prisma/client';
import { prisma, runInTransaction } from '../lib/db/prisma';
import { rupeesToPaise, toPaise, type Paise } from '../lib/db/money';
import { recordAudit } from '../lib/services/audit.service';
import {
  ensureDefaultCategories,
  findOrCreateCategory,
  getSettings,
} from '../lib/services/settings.service';
import type { AuthContext } from '../lib/auth/context';

/* ------------------------------------------------------------------ *
 * The shape of scripts/legacy-data.json
 * ------------------------------------------------------------------ */

const monthKeyField = z.string().refine(isMonthKey, { message: 'Expected a YYYY-MM month key' });
const isoDateField = z.string().refine(isIsoDate, { message: 'Expected a YYYY-MM-DD date' });
const positiveMoney = z.number().finite().positive().max(100_000_000);
const nonNegativeMoney = z.number().finite().nonnegative().max(100_000_000);

const legacyBuildingSchema = z.object({
  /** Short key the rest of the file uses to point at this building. */
  key: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(24).nullable().default(null),
  address: z.string().trim().min(1).max(300).nullable().default(null),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

const legacyFeePaymentSchema = z.object({
  amount: positiveMoney,
  date: isoDateField,
  /** Billing month this payment settles; defaults to the register's month. */
  month: monthKeyField.nullable().default(null),
  note: z.string().trim().min(1).max(500).nullable().default(null),
});

const legacyResidentSchema = z
  .object({
    building: z.string().trim().min(1),
    name: z.string().trim().min(1).max(150),
    monthlyFee: nonNegativeMoney,
    dueDay: z.number().int().min(1).max(31),
    joinMonth: monthKeyField,
    /** Set for a resident marked OUT; rent is charged up to and including it. */
    vacatedMonth: monthKeyField.nullable().default(null),
    /** null when the register shows nothing paid for the month. */
    payment: legacyFeePaymentSchema.nullable().default(null),
    phone: z.string().trim().min(1).max(20).nullable().default(null),
    notes: z.string().trim().min(1).max(2000).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.vacatedMonth && value.vacatedMonth < value.joinMonth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vacatedMonth'],
        message: 'Vacated month cannot be before the joining month',
      });
    }
  });

const legacyStaffSchema = z.object({
  name: z.string().trim().min(1).max(150),
  role: z.string().trim().min(1).max(80).nullable().default(null),
  /** null means the member works across every building - a shared cost. */
  building: z.string().trim().min(1).nullable().default(null),
  monthlySalary: nonNegativeMoney,
  joinMonth: monthKeyField.nullable().default(null),
  phone: z.string().trim().min(1).max(20).nullable().default(null),
});

const legacySalaryPaymentSchema = z.object({
  /** Matches a `staff[].name` in this same file. */
  staff: z.string().trim().min(1).max(150),
  salaryMonth: monthKeyField,
  amount: positiveMoney,
  date: isoDateField,
  note: z.string().trim().min(1).max(500).nullable().default(null),
});

const legacyExpenseSchema = z.object({
  date: isoDateField,
  /** null means a shared cost that was never attributed to one building. */
  building: z.string().trim().min(1).nullable().default(null),
  /** Category *name*; created through findOrCreateCategory when it is new. */
  category: z.string().trim().min(1).max(80),
  amount: positiveMoney,
  note: z.string().trim().min(1).max(500).nullable().default(null),
  vendor: z.string().trim().min(1).max(120).nullable().default(null),
});

const legacyDataSchema = z.object({
  /** The month the register covers; the default billing month for its payments. */
  sourceMonth: monthKeyField,
  buildings: z.array(legacyBuildingSchema).min(1, 'The register needs at least one building'),
  residents: z.array(legacyResidentSchema).default([]),
  staff: z.array(legacyStaffSchema).default([]),
  salaryPayments: z.array(legacySalaryPaymentSchema).default([]),
  expenses: z.array(legacyExpenseSchema).default([]),
});

export type LegacyData = z.infer<typeof legacyDataSchema>;
type LegacyResident = LegacyData['residents'][number];
type LegacyExpense = LegacyData['expenses'][number];

/* ------------------------------------------------------------------ *
 * Options, tallies and the reporting surface
 * ------------------------------------------------------------------ */

export interface LegacyImportOptions {
  /** Explicit path to the register file. Defaults to scripts/legacy-data.json. */
  file?: string;
  /** Parse and report only; no database connection is opened. */
  dryRun?: boolean;
  /** Required to run when NODE_ENV === 'production'. */
  allowProduction?: boolean;
  /** Transaction timeout; the whole register is one transaction. */
  timeoutMs?: number;
  /** Set false to import quietly (the seed prints its own headings). */
  log?: boolean;
}

export interface EntityTally {
  created: number;
  skipped: number;
}

export interface LegacyImportSummary {
  file: string;
  sourceMonth: string;
  dryRun: boolean;
  buildings: EntityTally;
  expenseCategories: EntityTally;
  residents: EntityTally;
  feePayments: EntityTally;
  staff: EntityTally;
  salaryPayments: EntityTally;
  expenses: EntityTally;
}

const tally = (): EntityTally => ({ created: 0, skipped: 0 });

/**
 * Per-phase transaction budget.
 *
 * MongoDB aborts a transaction that lives longer than
 * `transactionLifetimeLimitSeconds` - 60 by default, and not adjustable on an
 * Atlas shared tier - so this stays comfortably underneath it. It is a budget
 * for ONE phase, not for the whole import.
 */
const DEFAULT_TIMEOUT_MS = 45_000;
const DATA_FILE_NAME = 'legacy-data.json';

/**
 * The import is a system action, not a signed-in person's action. `recordAudit`
 * turns an empty userId into NULL, which is exactly the provenance wanted here:
 * these rows came off the old register and are attributable to no operator.
 */
const IMPORT_ACTOR: AuthContext = {
  userId: '',
  name: 'Legacy register import',
  email: 'legacy-import@localhost',
  role: 'OWNER',
  active: true,
  mustChangePassword: false,
};

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Case- and whitespace-insensitive key, so a re-run still matches "M.  Venkat". */
const normaliseName = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Canonical money key. Both sides of every idempotency comparison are reduced to
 * a whole number of paise: `paiseKey` for an amount read back out of the
 * database, `rupeeKey` for one read out of the register. Comparing a stored
 * 450000 against a source 4500 would never match, and the import would cheerfully
 * duplicate every payment on its second run.
 */
const paiseKey = (paise: Paise): string => String(toPaise(paise));
const rupeeKey = (rupees: number): string => paiseKey(rupeesToPaise(rupees));

type CountMap = Map<string, number>;

const addCount = (counts: CountMap, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

/**
 * Consume one occurrence of `key`. Counting rather than set-membership is what
 * keeps the import honest when the register itself repeats a transaction: two
 * identical 600-rupee vegetable entries on the same day are two real expenses,
 * and they stay two - not one, and not four - after a second run.
 */
function claimExisting(counts: CountMap, key: string): boolean {
  const remaining = counts.get(key) ?? 0;
  if (remaining <= 0) return false;
  counts.set(key, remaining - 1);
  return true;
}

/* ------------------------------------------------------------------ *
 * Loading and validating the register
 * ------------------------------------------------------------------ */

function candidatePaths(explicit: string | undefined): string[] {
  if (explicit) return [path.resolve(explicit)];
  const fromEnv = process.env.LEGACY_DATA_FILE;
  if (fromEnv) return [path.resolve(fromEnv)];
  const cwd = process.cwd();
  return [
    // run from apps/api - `npm run import:legacy`
    path.resolve(cwd, 'scripts', DATA_FILE_NAME),
    // run from apps/api/prisma
    path.resolve(cwd, '..', 'scripts', DATA_FILE_NAME),
    // run from the repository root
    path.resolve(cwd, 'apps', 'api', 'scripts', DATA_FILE_NAME),
    path.resolve(cwd, DATA_FILE_NAME),
  ];
}

export function resolveDataFile(explicit?: string): string {
  const candidates = candidatePaths(explicit);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(
    `Could not find ${DATA_FILE_NAME}. Looked in:\n` +
      `${candidates.map((c) => `  - ${c}`).join('\n')}\n` +
      'Pass --file=<path> or set LEGACY_DATA_FILE.',
  );
}

export function loadLegacyData(file: string): LegacyData {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${file} is not readable JSON: ${reason}`);
  }

  const parsed = legacyDataSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 25)
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`${file} does not match the legacy register format:\n${issues}`);
  }

  assertReferencesResolve(parsed.data, file);
  return parsed.data;
}

/** Cross-references are checked up front, so the transaction cannot half-apply. */
function assertReferencesResolve(data: LegacyData, file: string): void {
  const problems: string[] = [];

  const buildingKeys = new Set<string>();
  const buildingNames = new Set<string>();
  data.buildings.forEach((building, index) => {
    if (buildingKeys.has(building.key)) {
      problems.push(`buildings[${index}]: duplicate key "${building.key}"`);
    }
    buildingKeys.add(building.key);
    const nameKey = normaliseName(building.name);
    if (buildingNames.has(nameKey)) {
      problems.push(`buildings[${index}]: duplicate name "${building.name}"`);
    }
    buildingNames.add(nameKey);
  });

  const residentKeys = new Set<string>();
  data.residents.forEach((resident, index) => {
    if (!buildingKeys.has(resident.building)) {
      problems.push(
        `residents[${index}] "${resident.name}": unknown building "${resident.building}"`,
      );
    }
    const key = `${resident.building}|${normaliseName(resident.name)}`;
    if (residentKeys.has(key)) {
      problems.push(`residents[${index}]: "${resident.name}" appears twice in ${resident.building}`);
    }
    residentKeys.add(key);
  });

  const staffNames = new Set<string>();
  data.staff.forEach((member, index) => {
    if (member.building !== null && !buildingKeys.has(member.building)) {
      problems.push(`staff[${index}] "${member.name}": unknown building "${member.building}"`);
    }
    const key = normaliseName(member.name);
    if (staffNames.has(key)) problems.push(`staff[${index}]: "${member.name}" appears twice`);
    staffNames.add(key);
  });

  data.salaryPayments.forEach((payment, index) => {
    if (!staffNames.has(normaliseName(payment.staff))) {
      problems.push(`salaryPayments[${index}]: no staff member named "${payment.staff}"`);
    }
  });

  data.expenses.forEach((expense, index) => {
    if (expense.building !== null && !buildingKeys.has(expense.building)) {
      problems.push(`expenses[${index}]: unknown building "${expense.building}"`);
    }
  });

  if (problems.length > 0) {
    throw new Error(
      `${file} has unresolved references:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * The import itself
 * ------------------------------------------------------------------ */

interface BuildingRef {
  id: string;
  name: string;
}

interface ResidentRef {
  id: string;
  legacy: LegacyResident;
  buildingName: string;
}

export async function runLegacyImport(
  options: LegacyImportOptions = {},
): Promise<LegacyImportSummary> {
  const log = options.log !== false;
  const say = (message: string): void => {
    if (log) console.info(message);
  };

  assertNotProduction(options.allowProduction === true, log);

  const file = resolveDataFile(options.file);
  say(`[legacy-import] Reading ${file}`);
  const data = loadLegacyData(file);

  const feePaymentCount = data.residents.filter((resident) => resident.payment !== null).length;
  say(
    `[legacy-import] Register for ${data.sourceMonth}: ${data.buildings.length} buildings, ` +
      `${data.residents.length} residents, ${feePaymentCount} fee payments, ` +
      `${data.staff.length} staff, ${data.salaryPayments.length} salary payments, ` +
      `${data.expenses.length} expenses`,
  );

  const summary: LegacyImportSummary = {
    file,
    sourceMonth: data.sourceMonth,
    dryRun: options.dryRun === true,
    buildings: tally(),
    expenseCategories: tally(),
    residents: tally(),
    feePayments: tally(),
    staff: tally(),
    salaryPayments: tally(),
    expenses: tally(),
  };

  if (summary.dryRun) {
    // Validation pass only: the file is well formed and every reference in it
    // resolves. Nothing is compared against the database and no connection is
    // opened, so "created" here means "rows the file describes".
    summary.buildings.created = data.buildings.length;
    summary.expenseCategories.created = new Set(
      data.expenses.map((expense) => normaliseName(expense.category)),
    ).size;
    summary.residents.created = data.residents.length;
    summary.feePayments.created = feePaymentCount;
    summary.staff.created = data.staff.length;
    summary.salaryPayments.created = data.salaryPayments.length;
    summary.expenses.created = data.expenses.length;
    say('[legacy-import] --dry-run: the register is valid; the database was not touched.');
    if (log) printSummary(summary);
    return summary;
  }

  // Configuration bootstrap. Both are idempotent and belong to the application
  // rather than to the register, so they run outside the import transaction.
  await getSettings();
  await ensureDefaultCategories();

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * One phase = one transaction. The rows a phase creates and the audit entries
   * describing them commit together or not at all; a later phase failing leaves
   * the earlier ones committed, which is safe precisely because a re-run skips
   * everything that is already there.
   */
  const phase = async <T>(
    label: string,
    run: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> => {
    const startedAt = Date.now();
    const result = await runInTransaction(run, { timeoutMs });
    say(`[legacy-import] ${label} - ${Date.now() - startedAt}ms`);
    return result;
  };

  const buildings = await phase('1/6 buildings', (tx) =>
    importBuildings(tx, data, summary.buildings),
  );
  const residents = await phase('2/6 residents', (tx) =>
    importResidents(tx, data, buildings, summary.residents),
  );
  await phase('3/6 fee payments', (tx) =>
    importFeePayments(tx, data, residents, summary.feePayments),
  );
  const staff = await phase('4/6 staff', (tx) => importStaff(tx, data, buildings, summary.staff));
  await phase('5/6 salary payments', (tx) =>
    importSalaryPayments(tx, data, staff, summary.salaryPayments),
  );
  await phase('6/6 expenses', (tx) =>
    importExpenses(tx, data, buildings, summary.expenseCategories, summary.expenses),
  );

  if (log) printSummary(summary);
  return summary;
}

async function importBuildings(
  tx: Prisma.TransactionClient,
  data: LegacyData,
  counts: EntityTally,
): Promise<Map<string, BuildingRef>> {
  // The buildings table is tiny, so one read lets names be matched case-insensitively.
  const existing = await tx.building.findMany({ select: { id: true, name: true } });
  const byName = new Map(existing.map((row) => [normaliseName(row.name), row]));

  const resolved = new Map<string, BuildingRef>();
  for (const building of data.buildings) {
    const match = byName.get(normaliseName(building.name));
    if (match) {
      resolved.set(building.key, { id: match.id, name: match.name });
      counts.skipped += 1;
      continue;
    }

    // A code collision with a differently-named building must not abort the
    // import: the code is cosmetic, the name is the identity.
    const codeTaken =
      building.code !== null && (await tx.building.count({ where: { code: building.code } })) > 0;

    const created = await tx.building.create({
      data: {
        name: building.name,
        code: codeTaken ? null : building.code,
        address: building.address,
        sortOrder: building.sortOrder,
        active: true,
      },
      select: { id: true, name: true },
    });
    await recordAudit(tx, {
      auth: IMPORT_ACTOR,
      action: 'CREATE',
      entityType: 'BUILDING',
      entityId: created.id,
      summary: `Imported building ${created.name} from the legacy register`,
      newData: { name: created.name, code: building.code, sortOrder: building.sortOrder },
    });

    byName.set(normaliseName(created.name), created);
    resolved.set(building.key, created);
    counts.created += 1;
  }

  return resolved;
}

async function importResidents(
  tx: Prisma.TransactionClient,
  data: LegacyData,
  buildings: Map<string, BuildingRef>,
  counts: EntityTally,
): Promise<ResidentRef[]> {
  const buildingIds = [...new Set([...buildings.values()].map((building) => building.id))];

  // One query for every resident already living in the register's buildings -
  // never a lookup per row.
  const existing = await tx.resident.findMany({
    where: { buildingId: { in: buildingIds } },
    select: { id: true, name: true, buildingId: true },
  });
  const byKey = new Map(
    existing.map((row) => [`${row.buildingId}|${normaliseName(row.name)}`, row.id]),
  );

  const refs: ResidentRef[] = [];
  for (const resident of data.residents) {
    const building = buildings.get(resident.building);
    if (!building) throw new Error(`Unknown building "${resident.building}" for ${resident.name}`);

    const key = `${building.id}|${normaliseName(resident.name)}`;
    const existingId = byKey.get(key);
    if (existingId) {
      refs.push({ id: existingId, legacy: resident, buildingName: building.name });
      counts.skipped += 1;
      continue;
    }

    const created = await tx.resident.create({
      data: {
        name: resident.name,
        phone: resident.phone,
        buildingId: building.id,
        monthlyFee: rupeesToPaise(resident.monthlyFee),
        dueDay: resident.dueDay,
        // Rent runs from the first day of the joining month...
        joinDate: isoDateToUtcDate(firstDayOfMonth(resident.joinMonth)),
        // ...up to and including the last day of the vacating month.
        vacatedDate: resident.vacatedMonth
          ? isoDateToUtcDate(lastDayOfMonth(resident.vacatedMonth))
          : null,
        // Vacating is not archiving. The record stays active so the ledger, the
        // profile page and the arrears report keep working for a resident who
        // moved out owing money.
        active: true,
        notes: resident.notes,
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      auth: IMPORT_ACTOR,
      action: 'CREATE',
      entityType: 'RESIDENT',
      entityId: created.id,
      summary: `Imported resident ${resident.name} (${building.name}) from the legacy register`,
      // Audit payloads quote rupees, as every DTO-derived audit entry does; the
      // stored `monthlyFee` above is the paise equivalent.
      newData: {
        name: resident.name,
        building: building.name,
        monthlyFee: resident.monthlyFee,
        dueDay: resident.dueDay,
        joinMonth: resident.joinMonth,
        vacatedMonth: resident.vacatedMonth,
      },
    });

    byKey.set(key, created.id);
    refs.push({ id: created.id, legacy: resident, buildingName: building.name });
    counts.created += 1;
  }

  return refs;
}

async function importFeePayments(
  tx: Prisma.TransactionClient,
  data: LegacyData,
  residents: ResidentRef[],
  counts: EntityTally,
): Promise<void> {
  const payable = residents.filter((ref) => ref.legacy.payment !== null);
  if (payable.length === 0) return;

  const residentIds = payable.map((ref) => ref.id);
  const months = [...new Set(payable.map((ref) => ref.legacy.payment?.month ?? data.sourceMonth))];

  // One query covering every resident and billing month in the register.
  const existing = await tx.feePayment.findMany({
    where: {
      residentId: { in: residentIds },
      billingMonth: { in: months.map((month) => monthKeyToUtcDate(month)) },
    },
    select: { residentId: true, billingMonth: true, amount: true, paymentDate: true },
  });

  const seen: CountMap = new Map();
  for (const row of existing) {
    addCount(
      seen,
      [
        row.residentId,
        utcDateToMonthKey(row.billingMonth),
        paiseKey(row.amount),
        utcDateToIsoDate(row.paymentDate),
      ].join('|'),
    );
  }

  for (const ref of payable) {
    const payment = ref.legacy.payment;
    if (!payment) continue;

    const billingMonth = payment.month ?? data.sourceMonth;
    const key = [ref.id, billingMonth, rupeeKey(payment.amount), payment.date].join('|');
    if (claimExisting(seen, key)) {
      counts.skipped += 1;
      continue;
    }

    const created = await tx.feePayment.create({
      data: {
        residentId: ref.id,
        billingMonth: monthKeyToUtcDate(billingMonth),
        amount: rupeesToPaise(payment.amount),
        paymentDate: isoDateToUtcDate(payment.date),
        paymentMethod: 'CASH',
        note: payment.note,
        // No application user recorded this - it came off the paper register.
        createdById: null,
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      auth: IMPORT_ACTOR,
      action: 'CREATE',
      entityType: 'FEE_PAYMENT',
      entityId: created.id,
      summary: `Imported ${billingMonth} fee payment for ${ref.legacy.name} from the legacy register`,
      newData: {
        resident: ref.legacy.name,
        building: ref.buildingName,
        billingMonth,
        amount: payment.amount,
        paymentDate: payment.date,
      },
    });
    counts.created += 1;
  }
}

async function importStaff(
  tx: Prisma.TransactionClient,
  data: LegacyData,
  buildings: Map<string, BuildingRef>,
  counts: EntityTally,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (data.staff.length === 0) return resolved;

  const existing = await tx.staff.findMany({ select: { id: true, name: true } });
  const byName = new Map(existing.map((row) => [normaliseName(row.name), row.id]));

  for (const member of data.staff) {
    const nameKey = normaliseName(member.name);
    const existingId = byName.get(nameKey);
    if (existingId) {
      resolved.set(nameKey, existingId);
      counts.skipped += 1;
      continue;
    }

    const building = member.building ? buildings.get(member.building) : undefined;
    const created = await tx.staff.create({
      data: {
        name: member.name,
        phone: member.phone,
        role: member.role,
        // A null buildingId is meaningful: a cost shared across every building.
        buildingId: building?.id ?? null,
        monthlySalary: rupeesToPaise(member.monthlySalary),
        joinDate: member.joinMonth ? isoDateToUtcDate(firstDayOfMonth(member.joinMonth)) : null,
        active: true,
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      auth: IMPORT_ACTOR,
      action: 'CREATE',
      entityType: 'STAFF',
      entityId: created.id,
      summary: `Imported staff member ${member.name} from the legacy register`,
      newData: {
        name: member.name,
        role: member.role,
        building: building?.name ?? null,
        monthlySalary: member.monthlySalary,
      },
    });

    byName.set(nameKey, created.id);
    resolved.set(nameKey, created.id);
    counts.created += 1;
  }

  return resolved;
}

async function importSalaryPayments(
  tx: Prisma.TransactionClient,
  data: LegacyData,
  staff: Map<string, string>,
  counts: EntityTally,
): Promise<void> {
  if (data.salaryPayments.length === 0) return;

  const staffIds = [...new Set(staff.values())];
  const months = [...new Set(data.salaryPayments.map((payment) => payment.salaryMonth))];

  const existing = await tx.salaryPayment.findMany({
    where: {
      staffId: { in: staffIds },
      salaryMonth: { in: months.map((month) => monthKeyToUtcDate(month)) },
    },
    select: { staffId: true, salaryMonth: true, amount: true, paymentDate: true },
  });

  const seen: CountMap = new Map();
  for (const row of existing) {
    addCount(
      seen,
      [
        row.staffId,
        utcDateToMonthKey(row.salaryMonth),
        paiseKey(row.amount),
        utcDateToIsoDate(row.paymentDate),
      ].join('|'),
    );
  }

  for (const payment of data.salaryPayments) {
    const staffId = staff.get(normaliseName(payment.staff));
    if (!staffId) throw new Error(`No staff member named "${payment.staff}"`);

    const key = [staffId, payment.salaryMonth, rupeeKey(payment.amount), payment.date].join('|');
    if (claimExisting(seen, key)) {
      counts.skipped += 1;
      continue;
    }

    const created = await tx.salaryPayment.create({
      data: {
        staffId,
        salaryMonth: monthKeyToUtcDate(payment.salaryMonth),
        amount: rupeesToPaise(payment.amount),
        paymentDate: isoDateToUtcDate(payment.date),
        paymentMethod: 'CASH',
        note: payment.note,
        createdById: null,
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      auth: IMPORT_ACTOR,
      action: 'CREATE',
      entityType: 'SALARY_PAYMENT',
      entityId: created.id,
      summary: `Imported ${payment.salaryMonth} salary for ${payment.staff} from the legacy register`,
      newData: {
        staff: payment.staff,
        salaryMonth: payment.salaryMonth,
        amount: payment.amount,
        paymentDate: payment.date,
      },
    });
    counts.created += 1;
  }
}

async function importExpenses(
  tx: Prisma.TransactionClient,
  data: LegacyData,
  buildings: Map<string, BuildingRef>,
  categoryCounts: EntityTally,
  counts: EntityTally,
): Promise<void> {
  if (data.expenses.length === 0) return;

  // Every distinct category is resolved once - never one lookup per expense row.
  const categoryIds = await resolveCategories(tx, data.expenses, categoryCounts);

  const dates = data.expenses.map((expense) => expense.date).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return;

  // One query across the register's date window.
  const existing = await tx.expense.findMany({
    where: { date: { gte: isoDateToUtcDate(first), lte: isoDateToUtcDate(last) } },
    select: { date: true, amount: true, note: true },
  });

  const seen: CountMap = new Map();
  for (const row of existing) {
    addCount(seen, [utcDateToIsoDate(row.date), paiseKey(row.amount), row.note ?? ''].join('|'));
  }

  for (const expense of data.expenses) {
    const key = [expense.date, rupeeKey(expense.amount), expense.note ?? ''].join('|');
    if (claimExisting(seen, key)) {
      counts.skipped += 1;
      continue;
    }

    const categoryId = categoryIds.get(normaliseName(expense.category));
    if (!categoryId) throw new Error(`Unresolved expense category "${expense.category}"`);
    const building = expense.building ? buildings.get(expense.building) : undefined;

    const created = await tx.expense.create({
      data: {
        date: isoDateToUtcDate(expense.date),
        // A null buildingId is meaningful: a shared running cost.
        buildingId: building?.id ?? null,
        categoryId,
        amount: rupeesToPaise(expense.amount),
        vendor: expense.vendor,
        note: expense.note,
        createdById: null,
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      auth: IMPORT_ACTOR,
      action: 'CREATE',
      entityType: 'EXPENSE',
      entityId: created.id,
      summary: `Imported ${expense.category} expense dated ${expense.date} from the legacy register`,
      newData: {
        date: expense.date,
        category: expense.category,
        building: building?.name ?? null,
        amount: expense.amount,
        note: expense.note,
      },
    });
    counts.created += 1;
  }
}

/** name (normalised) -> category id, for every distinct category in the register. */
async function resolveCategories(
  tx: Prisma.TransactionClient,
  expenses: LegacyExpense[],
  counts: EntityTally,
): Promise<Map<string, string>> {
  const names = [...new Set(expenses.map((expense) => expense.category))];
  const existing = await tx.expenseCategory.findMany({ select: { id: true, name: true } });
  const byName = new Map(existing.map((row) => [normaliseName(row.name), row.id]));

  const resolved = new Map<string, string>();
  for (const name of names) {
    const nameKey = normaliseName(name);
    const existingId = byName.get(nameKey);
    if (existingId) {
      resolved.set(nameKey, existingId);
      counts.skipped += 1;
      continue;
    }

    // findOrCreateCategory owns slug generation and the name/slug collision rules.
    const category = await findOrCreateCategory(name, tx);
    await recordAudit(tx, {
      auth: IMPORT_ACTOR,
      action: 'CREATE',
      entityType: 'EXPENSE_CATEGORY',
      entityId: category.id,
      summary: `Created expense category ${category.name} for the legacy register`,
      newData: { name: category.name },
    });

    byName.set(normaliseName(category.name), category.id);
    resolved.set(nameKey, category.id);
    counts.created += 1;
  }

  return resolved;
}

/* ------------------------------------------------------------------ *
 * Guards and reporting
 * ------------------------------------------------------------------ */

export function assertNotProduction(allowProduction: boolean, log = true): void {
  if (process.env.NODE_ENV !== 'production') return;

  if (!allowProduction) {
    throw new Error(
      'Refusing to import the legacy register: NODE_ENV is "production".\n' +
        'This script writes historical business data straight into the live database.\n' +
        'If that really is what you want, re-run it with --allow-production.',
    );
  }

  if (log) {
    console.warn('');
    console.warn('  ****************************************************************');
    console.warn('  **  WARNING: importing the legacy register into PRODUCTION.   **');
    console.warn('  **  Historical residents, payments and expenses are about to  **');
    console.warn('  **  be written to the live database. Take a backup first.     **');
    console.warn('  ****************************************************************');
    console.warn('');
  }
}

const SUMMARY_ROWS: ReadonlyArray<readonly [keyof LegacyImportSummary, string]> = [
  ['buildings', 'Buildings'],
  ['expenseCategories', 'Expense categories'],
  ['residents', 'Residents'],
  ['feePayments', 'Fee payments'],
  ['staff', 'Staff'],
  ['salaryPayments', 'Salary payments'],
  ['expenses', 'Expenses'],
];

const isTally = (value: LegacyImportSummary[keyof LegacyImportSummary]): value is EntityTally =>
  typeof value === 'object' && value !== null;

export function printSummary(summary: LegacyImportSummary): void {
  const heading = summary.dryRun
    ? `Legacy register ${summary.sourceMonth} - DRY RUN, nothing was written`
    : `Legacy register ${summary.sourceMonth} - import complete`;

  console.info('');
  console.info(heading);
  console.info('  Entity              Created   Skipped');
  console.info('  ------------------  -------   -------');

  let created = 0;
  let skipped = 0;
  for (const [key, label] of SUMMARY_ROWS) {
    const row = summary[key];
    if (!isTally(row)) continue;
    created += row.created;
    skipped += row.skipped;
    console.info(
      `  ${label.padEnd(18)}  ${String(row.created).padStart(7)}   ${String(row.skipped).padStart(7)}`,
    );
  }

  console.info('  ------------------  -------   -------');
  console.info(
    `  ${'Total'.padEnd(18)}  ${String(created).padStart(7)}   ${String(skipped).padStart(7)}`,
  );
  console.info('');
  if (!summary.dryRun) {
    console.info('  Skipped rows were already present - this import is safe to run again.');
    console.info('');
  }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export function parseLegacyArgs(argv: string[]): LegacyImportOptions {
  const options: LegacyImportOptions = {};
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--allow-production') options.allowProduction = true;
    else if (arg.startsWith('--file=')) options.file = arg.slice('--file='.length);
    else if (arg.startsWith('--timeout-ms=')) {
      const parsed = Number(arg.slice('--timeout-ms='.length));
      if (Number.isFinite(parsed) && parsed > 0) options.timeoutMs = Math.trunc(parsed);
    }
  }
  return options;
}

/**
 * True only when node/tsx was pointed at this file. Importing the module - the
 * seed does, for `--with-legacy` - must never start an import by itself.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.basename(entry).replace(/\.(ts|tsx|js|mjs|cjs)$/, '') === 'import-legacy-data';
}

async function main(): Promise<void> {
  try {
    await runLegacyImport(parseLegacyArgs(process.argv.slice(2)));
  } catch (error) {
    console.error('');
    console.error('[legacy-import] FAILED - nothing was committed.');
    console.error(error instanceof Error ? error.message : error);
    console.error('');
    process.exitCode = 1;
  } finally {
    // The Prisma client is constructed lazily, on the first property access, so
    // on a run that never reached the database - the production guard tripping,
    // an unreadable register - this call would build one purely in order to
    // close it, and fail all over again on whatever stopped the run. Closing is
    // best-effort; the exit code above is what reports the outcome.
    try {
      await prisma.$disconnect();
    } catch {
      // Nothing was ever connected.
    }
  }
}

if (invokedDirectly()) void main();
