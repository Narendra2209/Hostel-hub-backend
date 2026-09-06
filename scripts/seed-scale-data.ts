/**
 * SCALE-TEST DATA GENERATOR.
 *
 * Builds a large, realistic register in a SEPARATE MongoDB database so the real
 * one is never touched. The load test (scripts/load-test.ts) needs a dataset
 * big enough that the query patterns behave the way they will in production:
 * a roster the fee engine has to walk, twelve months of payments with gaps so
 * the arrears calculation has something to chew on, and enough users that the
 * per-request `requireAuth` lookup is not one hot document.
 *
 * SAFETY
 * ------
 * Three things stand between this script and the live register:
 *
 *  1. The target database name is derived by appending `_scaletest` to the name
 *     in DATABASE_URL (or given explicitly with --database). If the resolved
 *     name equals the live one the script refuses outright - there is no flag
 *     that overrides that.
 *  2. The resolved name must look like a scratch database (scale/test/perf/
 *     bench/load in the name) unless --allow-any-name is passed, because this
 *     script DROPS the collections it is about to fill.
 *  3. Nothing is written without --yes. Without it the script prints exactly
 *     what it would do and exits non-zero, so a forgotten flag in a pipeline
 *     fails loudly instead of silently doing nothing.
 *
 * The cluster is the same one - only the database differs. That is deliberate:
 * a load test against a different cluster tier would measure the wrong thing.
 *
 * INDEXES
 * -------
 * MongoDB creates collections on first insert but not the indexes declared in
 * schema.prisma, and an unindexed collection scan would make every latency
 * number a lie. The script therefore creates the schema's indexes itself with
 * `$runCommandRaw` (idempotent - `createIndexes` is a no-op for an index that
 * already exists), so no separate `prisma db push` against the scale database
 * is needed.
 *
 * MONEY
 * -----
 * Every amount is generated in rupees and crosses `rupeesToPaise()` on the way
 * in, exactly as a real request would. Nothing is written as a float.
 *
 * USAGE
 * -----
 *   npm run seed:scale                    # prints the plan, writes nothing
 *   npm run seed:scale -- --yes           # generate
 *   npm run seed:scale -- --yes --residents=200 --expenses=300   # quick run
 *   npm run seed:scale -- --yes --database=hostel_perf --allow-any-name
 */
import { ObjectId } from 'mongodb';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  APP_TIMEZONE,
  DEFAULT_CURRENCY_CODE,
  DEFAULT_CURRENCY_SYMBOL,
  DEFAULT_DUE_DAY,
  DEFAULT_EXPENSE_CATEGORIES,
  currentMonthKey,
  daysInMonth,
  dueDateForMonth,
  isoDate,
  isoDateToUtcDate,
  lastDayOfMonth,
  monthKeyToUtcDate,
  nextMonthKey,
  parseMonthKey,
  todayIso,
  type IsoDate,
  type MonthKey,
} from '@hostel/shared';
import { rupeesToPaise } from '../lib/db/money';
import { hashPassword } from '../lib/auth/password';
import {
  LOAD_TEST_PASSWORD,
  LOAD_TEST_USER_COUNT,
  loadTestEmail,
  loadTestName,
  loadTestRole,
  type LoadTestRole,
} from './load-test';

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const SCALE_SUFFIX = '_scaletest';
const SCRATCH_NAME_PATTERN = /scale|test|perf|bench|load/i;
/** MongoDB's own limit is 64 bytes; the character set is narrowed on purpose. */
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,63}$/;

/** insertMany batch size. Large enough to amortise the round trip, small
 *  enough to stay far below the 16 MB BSON command limit. */
const BATCH_SIZE = 1_000;

interface ScaleConfig {
  buildings: number;
  residents: number;
  staff: number;
  expenses: number;
  users: number;
  auditLogs: number;
  /** Depth of the payment history, in months, ending at the current month. */
  months: number;
  seed: number;
}

const DEFAULT_CONFIG: ScaleConfig = {
  buildings: 5,
  residents: 1_200,
  staff: 30,
  expenses: 2_000,
  users: 50,
  auditLogs: 5_000,
  months: 12,
  seed: 20_260_906,
};

/* ------------------------------------------------------------------ *
 * Deterministic randomness
 *
 * A fixture set that changes shape between runs makes two load tests
 * incomparable, so every choice below comes from one seeded generator.
 * ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Random {
  next: () => number;
  /** Inclusive integer in [min, max]. */
  int: (min: number, max: number) => number;
  pick: <T>(values: readonly T[]) => T;
  chance: (probability: number) => boolean;
  /** Picks by relative weight; the two arrays must be the same length. */
  weighted: <T>(values: readonly T[], weights: readonly number[]) => T;
}

function makeRandom(seed: number): Random {
  const next = mulberry32(seed);
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(values: readonly T[]): T => values[int(0, values.length - 1)]!;
  const chance = (probability: number): boolean => next() < probability;
  const weighted = <T>(values: readonly T[], weights: readonly number[]): T => {
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let ticket = next() * total;
    for (let index = 0; index < values.length; index += 1) {
      ticket -= weights[index] ?? 0;
      if (ticket <= 0) return values[index]!;
    }
    return values[values.length - 1]!;
  };
  return { next, int, pick, chance, weighted };
}

/* ------------------------------------------------------------------ *
 * Name pools - enough combinations that 1,200 residents do not repeat much
 * ------------------------------------------------------------------ */

const FIRST_NAMES = [
  'Aarav', 'Aditi', 'Akhil', 'Ananya', 'Anil', 'Anjali', 'Arjun', 'Ashwin', 'Bhavana', 'Chaitanya',
  'Charan', 'Deepak', 'Divya', 'Ganesh', 'Gayatri', 'Harsha', 'Hemanth', 'Indira', 'Ishaan', 'Jyothi',
  'Kavya', 'Keerthi', 'Kiran', 'Lakshmi', 'Madhav', 'Mahesh', 'Manoj', 'Meera', 'Mohan', 'Naveen',
  'Nikhil', 'Nithya', 'Pallavi', 'Pavan', 'Pooja', 'Praveen', 'Priya', 'Rahul', 'Rajesh', 'Rakesh',
  'Ramya', 'Ravi', 'Rekha', 'Rohit', 'Sandeep', 'Sanjay', 'Saritha', 'Shalini', 'Shiva', 'Shruti',
  'Sneha', 'Srikanth', 'Sudha', 'Sunil', 'Suresh', 'Swathi', 'Tejaswi', 'Uday', 'Vandana', 'Varun',
  'Venkat', 'Vidya', 'Vijay', 'Vikram', 'Vinay', 'Yamini',
] as const;

const LAST_NAMES = [
  'Achar', 'Bhat', 'Chandra', 'Deshpande', 'Gowda', 'Hegde', 'Iyer', 'Jain', 'Kamath', 'Kulkarni',
  'Kumar', 'Menon', 'Nadkarni', 'Naidu', 'Nair', 'Pai', 'Patel', 'Pillai', 'Prasad', 'Raju',
  'Rao', 'Reddy', 'Sharma', 'Shenoy', 'Shetty', 'Singh', 'Sridhar', 'Subramanian', 'Varma', 'Verma',
] as const;

const STAFF_ROLES = [
  'Cook', 'Assistant cook', 'Housekeeping', 'Security guard', 'Night watchman',
  'Warden', 'Maintenance', 'Electrician', 'Plumber', 'Manager',
] as const;

const BUILDING_SEEDS = [
  { name: 'Nandi Block', code: 'NB', address: '12 Kaveri Road, Bengaluru 560001' },
  { name: 'Kaveri Block', code: 'KB', address: '48 Residency Cross, Bengaluru 560025' },
  { name: 'Tunga Residency', code: 'TR', address: '7 Mill Corner, Bengaluru 560053' },
  { name: 'Sharavathi House', code: 'SH', address: '221 Old Airport Road, Bengaluru 560017' },
  { name: 'Hemavathi Annexe', code: 'HA', address: '3 Church Street, Bengaluru 560001' },
] as const;

/** Relative building sizes, so the roster is not five equal blocks. */
const BUILDING_WEIGHTS = [28, 24, 20, 16, 12] as const;

const VENDORS = [
  'BESCOM', 'BWSSB', 'Indane Gas', 'ACT Fibernet', 'Airtel Broadband', 'Sri Balaji Traders',
  'More Supermarket', 'Metro Cash & Carry', 'Sharma Hardware', 'Lakshmi Electricals',
  'Aqua Pure Services', 'Clean Sweep Facility', 'Prakash Plumbing', 'Vinayaka Enterprises',
] as const;

/** Per-category rupee ranges, so the P&L breakdown is not uniform noise. */
const CATEGORY_RANGES: Record<string, { min: number; max: number; weight: number }> = {
  electricity: { min: 4_000, max: 38_000, weight: 16 },
  water: { min: 1_200, max: 9_000, weight: 12 },
  'gas-lpg': { min: 1_800, max: 14_000, weight: 12 },
  internet: { min: 900, max: 4_500, weight: 8 },
  'mess-groceries': { min: 3_000, max: 65_000, weight: 24 },
  maintenance: { min: 500, max: 22_000, weight: 14 },
  'building-rent': { min: 25_000, max: 120_000, weight: 6 },
  other: { min: 300, max: 12_000, weight: 8 },
};

const PAYMENT_METHODS = ['CASH', 'UPI', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'OTHER'] as const;
const PAYMENT_METHOD_WEIGHTS = [45, 35, 12, 4, 3, 1] as const;
type PaymentMethodLiteral = (typeof PAYMENT_METHODS)[number];

/* ------------------------------------------------------------------ *
 * Target resolution and the guards
 * ------------------------------------------------------------------ */

interface Target {
  host: string;
  liveDatabase: string;
  database: string;
  url: string;
}

export function resolveTarget(
  rawUrl: string,
  override: string | undefined,
  allowAnyName: boolean,
): Target {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('DATABASE_URL is not a parseable connection string.');
  }

  const liveDatabase = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!liveDatabase) {
    throw new Error(
      'DATABASE_URL carries no database name (nothing after the host). Add one, e.g. ' +
        'mongodb+srv://user:pass@cluster/hostel?retryWrites=true',
    );
  }

  const database = (override ?? '').trim() || `${liveDatabase}${SCALE_SUFFIX}`;

  if (!DATABASE_NAME_PATTERN.test(database)) {
    throw new Error(
      `"${database}" is not a usable database name. Use letters, digits, hyphen or underscore.`,
    );
  }

  // The one refusal with no override. Everything below this line drops
  // collections, so it must never be able to point at the live register.
  if (database === liveDatabase) {
    throw new Error(
      `REFUSING TO RUN: the resolved target "${database}" is the live database named in ` +
        'DATABASE_URL. The scale seed only ever writes to a separate database.',
    );
  }

  if (!allowAnyName && !SCRATCH_NAME_PATTERN.test(database)) {
    throw new Error(
      `REFUSING TO RUN: "${database}" does not look like a scratch database, and this script ` +
        'drops the collections it fills. Rename it (something containing "scale", "test", "perf", ' +
        '"bench" or "load") or pass --allow-any-name if you are certain.',
    );
  }

  url.pathname = `/${database}`;
  return { host: url.host, liveDatabase, database, url: url.toString() };
}

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

export interface SeedOptions extends ScaleConfig {
  confirmed: boolean;
  database: string | undefined;
  allowAnyName: boolean;
}

function readFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) continue;
    const equals = arg.indexOf('=');
    if (equals >= 0) {
      flags.set(arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next);
      index += 1;
    } else {
      flags.set(arg.slice(2), 'true');
    }
  }
  return flags;
}

export function parseSeedArgs(argv: string[]): SeedOptions {
  const flags = readFlags(argv);

  const count = (name: string, fallback: number, min: number, max: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`--${name} must be a whole number between ${min} and ${max} (got "${raw}")`);
    }
    return value;
  };

  return {
    confirmed: flags.get('yes') === 'true',
    database: flags.get('database') ?? flags.get('db'),
    allowAnyName: flags.get('allow-any-name') === 'true',
    buildings: count('buildings', DEFAULT_CONFIG.buildings, 1, 50),
    residents: count('residents', DEFAULT_CONFIG.residents, 1, 200_000),
    staff: count('staff', DEFAULT_CONFIG.staff, 0, 5_000),
    expenses: count('expenses', DEFAULT_CONFIG.expenses, 0, 500_000),
    users: count('users', DEFAULT_CONFIG.users, LOAD_TEST_USER_COUNT, 5_000),
    auditLogs: count('audit-logs', DEFAULT_CONFIG.auditLogs, 0, 500_000),
    months: count('months', DEFAULT_CONFIG.months, 1, 120),
    seed: count('seed', DEFAULT_CONFIG.seed, 1, Number.MAX_SAFE_INTEGER),
  };
}

/* ------------------------------------------------------------------ *
 * Timing and batching
 * ------------------------------------------------------------------ */

interface Phase {
  label: string;
  ms: number;
  rows: number;
}

const phases: Phase[] = [];

function formatMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

const formatCount = (value: number): string => value.toLocaleString('en-US');

async function phase<T>(label: string, run: () => Promise<{ value: T; rows: number }>): Promise<T> {
  const startedAt = Date.now();
  const { value, rows } = await run();
  const ms = Date.now() - startedAt;
  phases.push({ label, ms, rows });
  console.info(
    `  ${label.padEnd(26)} ${formatCount(rows).padStart(9)} rows  ${formatMs(ms).padStart(9)}`,
  );
  return value;
}

/** insertMany in batches. A per-document insert of 12,000 payments over an
 *  Atlas round trip each would take minutes; batched it is a few seconds. */
async function insertBatched<T>(
  rows: readonly T[],
  write: (batch: T[]) => Promise<unknown>,
): Promise<number> {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    await write(rows.slice(offset, offset + BATCH_SIZE));
  }
  return rows.length;
}

/* ------------------------------------------------------------------ *
 * Schema maintenance: drop, then recreate the indexes schema.prisma declares
 * ------------------------------------------------------------------ */

const COLLECTIONS = [
  'users',
  'hostel_settings',
  'buildings',
  'expense_categories',
  'residents',
  'resident_building_history',
  'fee_payments',
  'staff',
  'salary_payments',
  'expenses',
  'audit_logs',
] as const;

interface IndexSpec {
  name: string;
  key: Record<string, 1 | -1>;
  unique?: boolean;
}

/** Mirrors every @@index / @unique in prisma/schema.prisma for the collections
 *  this script fills. Kept as data so a drifting schema is one edit away. */
const INDEXES: Record<string, IndexSpec[]> = {
  users: [
    { name: 'email_unique', key: { email: 1 }, unique: true },
    { name: 'role_idx', key: { role: 1 } },
    { name: 'active_idx', key: { active: 1 } },
  ],
  hostel_settings: [{ name: 'singleton_unique', key: { singleton: 1 }, unique: true }],
  buildings: [
    { name: 'name_unique', key: { name: 1 }, unique: true },
    { name: 'code_unique', key: { code: 1 }, unique: true },
    { name: 'active_sortOrder_idx', key: { active: 1, sortOrder: 1 } },
  ],
  expense_categories: [
    { name: 'slug_unique', key: { slug: 1 }, unique: true },
    { name: 'name_unique', key: { name: 1 }, unique: true },
    { name: 'active_sortOrder_idx', key: { active: 1, sortOrder: 1 } },
  ],
  residents: [
    { name: 'buildingId_idx', key: { buildingId: 1 } },
    { name: 'active_idx', key: { active: 1 } },
    { name: 'buildingId_active_idx', key: { buildingId: 1, active: 1 } },
    { name: 'name_idx', key: { name: 1 } },
    { name: 'joinDate_idx', key: { joinDate: 1 } },
    { name: 'vacatedDate_idx', key: { vacatedDate: 1 } },
  ],
  resident_building_history: [
    { name: 'residentId_effectiveDate_idx', key: { residentId: 1, effectiveDate: 1 } },
  ],
  fee_payments: [
    { name: 'residentId_billingMonth_idx', key: { residentId: 1, billingMonth: 1 } },
    { name: 'billingMonth_idx', key: { billingMonth: 1 } },
    { name: 'paymentDate_idx', key: { paymentDate: 1 } },
    { name: 'residentId_idx', key: { residentId: 1 } },
  ],
  staff: [
    { name: 'buildingId_idx', key: { buildingId: 1 } },
    { name: 'active_idx', key: { active: 1 } },
    { name: 'name_idx', key: { name: 1 } },
  ],
  salary_payments: [
    { name: 'staffId_salaryMonth_idx', key: { staffId: 1, salaryMonth: 1 } },
    { name: 'salaryMonth_idx', key: { salaryMonth: 1 } },
    { name: 'paymentDate_idx', key: { paymentDate: 1 } },
  ],
  expenses: [
    { name: 'date_idx', key: { date: 1 } },
    { name: 'buildingId_date_idx', key: { buildingId: 1, date: 1 } },
    { name: 'categoryId_date_idx', key: { categoryId: 1, date: 1 } },
  ],
  audit_logs: [
    { name: 'entityType_entityId_idx', key: { entityType: 1, entityId: 1 } },
    { name: 'createdAt_idx', key: { createdAt: 1 } },
    { name: 'userId_idx', key: { userId: 1 } },
  ],
};

/** MongoDB's "collection does not exist"; dropping one is a success, not a failure. */
const NAMESPACE_NOT_FOUND = 26;

function isNamespaceNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const message = error instanceof Error ? error.message : '';
  const code = (error as { code?: unknown }).code;
  return code === NAMESPACE_NOT_FOUND || /ns not found|NamespaceNotFound/i.test(message);
}

async function dropCollections(db: PrismaClient): Promise<number> {
  let dropped = 0;
  for (const collection of COLLECTIONS) {
    try {
      await db.$runCommandRaw({ drop: collection });
      dropped += 1;
    } catch (error) {
      if (!isNamespaceNotFound(error)) throw error;
    }
  }
  return dropped;
}

async function createIndexes(db: PrismaClient): Promise<number> {
  let created = 0;
  for (const [collection, specs] of Object.entries(INDEXES)) {
    const command: Prisma.InputJsonObject = {
      createIndexes: collection,
      indexes: specs.map((spec) => ({
        key: { ...spec.key },
        name: spec.name,
        ...(spec.unique ? { unique: true } : {}),
      })),
    };
    await db.$runCommandRaw(command);
    created += specs.length;
  }
  return created;
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

const newId = (): string => new ObjectId().toHexString();

/** The inclusive list of month keys the fixture covers, oldest first. */
function historyMonths(current: MonthKey, depth: number): MonthKey[] {
  const months: MonthKey[] = [];
  for (let offset = depth - 1; offset >= 0; offset -= 1) months.push(nextMonthKey(current, -offset));
  return months;
}

/** A random calendar day inside a month, as an ISO date, never after `today`. */
function dayInMonth(month: MonthKey, random: Random, today: IsoDate): IsoDate {
  const { year, month: monthNumber } = parseMonthKey(month);
  const day = random.int(1, daysInMonth(year, monthNumber));
  const candidate = isoDate(year, monthNumber, day);
  return candidate > today ? today : candidate;
}

/** Shift an ISO date by whole days, staying on the UTC-midnight rail. */
function shiftIsoDate(value: IsoDate, days: number): IsoDate {
  const shifted = new Date(isoDateToUtcDate(value).getTime() + days * 86_400_000);
  return isoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

type PayerClass = 'punctual' | 'late' | 'partial' | 'delinquent';
const PAYER_CLASSES: readonly PayerClass[] = ['punctual', 'late', 'partial', 'delinquent'];
const PAYER_WEIGHTS = [62, 20, 11, 7] as const;

interface GeneratedResident {
  row: Prisma.ResidentCreateManyInput;
  joinMonth: MonthKey;
  lastBilledMonth: MonthKey;
  monthlyFeePaise: number;
  payer: PayerClass;
}

function generateResidents(
  config: ScaleConfig,
  random: Random,
  buildingIds: string[],
  months: MonthKey[],
  today: IsoDate,
): GeneratedResident[] {
  const currentMonth = months[months.length - 1]!;
  const buildingIndexes = buildingIds.map((_, index) => index);
  const weights = buildingIds.map((_, index) => BUILDING_WEIGHTS[index] ?? 10);
  const residents: GeneratedResident[] = [];

  for (let index = 0; index < config.residents; index += 1) {
    const buildingIndex = random.weighted(buildingIndexes, weights);
    const buildingId = buildingIds[buildingIndex]!;

    // Most residents have been here the whole window; the rest arrived during
    // it. That is what gives the ledger a mix of full and partial histories.
    const joinOffset = random.chance(0.55) ? 0 : random.int(0, months.length - 1);
    const joinMonth = months[joinOffset]!;

    // A few have moved out. Their rent stops that month and their history stays.
    const canVacate = joinOffset < months.length - 1;
    const vacates = canVacate && random.chance(0.06);
    const vacatedMonth = vacates
      ? months[random.int(joinOffset + 1, months.length - 1)]!
      : null;

    const baseFee = 3_500 + buildingIndex * 500;
    const monthlyFeeRupees = baseFee + random.int(-2, 6) * 250;
    const monthlyFeePaise = rupeesToPaise(Math.max(2_500, monthlyFeeRupees));

    const name = `${random.pick(FIRST_NAMES)} ${random.pick(LAST_NAMES)}`;
    // Archived means "no longer on the roster at all"; only ever a leaver.
    const archived = vacatedMonth !== null && random.chance(0.4);

    residents.push({
      row: {
        id: newId(),
        name,
        phone: `9${random.int(100_000_000, 999_999_999)}`,
        email: random.chance(0.7)
          ? `${name.toLowerCase().replace(/[^a-z]+/g, '.')}${index}@example.invalid`
          : null,
        buildingId,
        monthlyFee: monthlyFeePaise,
        dueDay: random.weighted([DEFAULT_DUE_DAY, 1, 10, 15], [70, 10, 12, 8]),
        joinDate: monthKeyToUtcDate(joinMonth),
        vacatedDate: vacatedMonth ? isoDateToUtcDate(lastDayOfMonth(vacatedMonth)) : null,
        active: !archived,
        notes: random.chance(0.12) ? 'Sharing a twin room.' : null,
        archivedAt: archived ? isoDateToUtcDate(lastDayOfMonth(vacatedMonth!)) : null,
        createdAt: monthKeyToUtcDate(joinMonth),
        updatedAt: isoDateToUtcDate(today),
      },
      joinMonth,
      lastBilledMonth: vacatedMonth ?? currentMonth,
      monthlyFeePaise,
      payer: random.weighted(PAYER_CLASSES, PAYER_WEIGHTS),
    });
  }

  return residents;
}

/**
 * Fee payments with realistic gaps.
 *
 * The gaps are the point. `residentArrears` in the fee engine walks every
 * billable month and reports the ones with an unmet balance whose due date has
 * passed, so a fixture where everybody pays would leave the overdue screen, the
 * dashboard's arrears card and the "who owes money" list all empty - and those
 * are three of the six endpoints under load.
 */
function generateFeePayments(
  residents: readonly GeneratedResident[],
  months: MonthKey[],
  random: Random,
  userIds: string[],
  today: IsoDate,
): Prisma.FeePaymentCreateManyInput[] {
  const payments: Prisma.FeePaymentCreateManyInput[] = [];
  const currentMonth = months[months.length - 1]!;

  for (const resident of residents) {
    const billable = months.filter(
      (month) => month >= resident.joinMonth && month <= resident.lastBilledMonth,
    );

    for (let index = 0; index < billable.length; index += 1) {
      const month = billable[index]!;
      const monthsAgo = billable.length - 1 - index;
      const isCurrentMonth = month === currentMonth;

      let skip = false;
      let fraction = 1;

      switch (resident.payer) {
        case 'punctual':
          // Even a reliable payer has not necessarily paid this month yet.
          skip = isCurrentMonth && random.chance(0.45);
          break;
        case 'late':
          skip = (isCurrentMonth && random.chance(0.7)) || (monthsAgo === 1 && random.chance(0.25));
          break;
        case 'partial':
          skip = isCurrentMonth && random.chance(0.6);
          if (!skip && random.chance(0.4)) fraction = random.int(30, 80) / 100;
          break;
        case 'delinquent':
          // Stopped paying a few months ago and never restarted.
          skip = monthsAgo <= random.int(2, 4);
          break;
      }
      if (skip) continue;

      const dueDate = dueDateForMonth(month, resident.row.dueDay);
      const offset =
        resident.payer === 'late' ? random.int(1, 20) : -random.int(0, 4);
      const attempted = shiftIsoDate(dueDate, offset);
      // A payment cannot have arrived in the future, and cannot pre-date the
      // month it settles.
      const floor = `${month}-01`;
      const paymentDate = (attempted > today ? today : attempted < floor ? floor : attempted) as IsoDate;
      if (paymentDate > today) continue;

      const amountPaise = Math.round(resident.monthlyFeePaise * fraction);
      if (amountPaise <= 0) continue;

      const method = random.weighted(PAYMENT_METHODS, PAYMENT_METHOD_WEIGHTS);
      payments.push({
        id: newId(),
        residentId: resident.row.id!,
        billingMonth: monthKeyToUtcDate(month),
        amount: amountPaise,
        paymentDate: isoDateToUtcDate(paymentDate),
        paymentMethod: method as PaymentMethodLiteral,
        referenceNumber: referenceFor(method, random),
        note: fraction < 1 ? 'Part payment' : null,
        createdById: random.pick(userIds),
        createdAt: isoDateToUtcDate(paymentDate),
        updatedAt: isoDateToUtcDate(paymentDate),
      });
    }
  }

  return payments;
}

function referenceFor(method: PaymentMethodLiteral, random: Random): string | null {
  switch (method) {
    case 'UPI':
      return `UPI${random.int(100_000_000, 999_999_999)}`;
    case 'BANK_TRANSFER':
      return `NEFT${random.int(10_000_000, 99_999_999)}`;
    case 'CHEQUE':
      return `CHQ${random.int(100_000, 999_999)}`;
    default:
      return null;
  }
}

interface GeneratedStaff {
  row: Prisma.StaffCreateManyInput;
  joinMonth: MonthKey;
  salaryPaise: number;
}

function generateStaff(
  config: ScaleConfig,
  random: Random,
  buildingIds: string[],
  months: MonthKey[],
): GeneratedStaff[] {
  const staff: GeneratedStaff[] = [];
  for (let index = 0; index < config.staff; index += 1) {
    // A fifth work across every building; those are the shared-cost rows the
    // dashboard reports separately and never allocates.
    const shared = random.chance(0.2);
    const joinMonth = months[random.int(0, Math.max(0, months.length - 2))]!;
    const salaryPaise = rupeesToPaise(random.int(32, 140) * 250);

    staff.push({
      row: {
        id: newId(),
        name: `${random.pick(FIRST_NAMES)} ${random.pick(LAST_NAMES)}`,
        phone: `8${random.int(100_000_000, 999_999_999)}`,
        role: random.pick(STAFF_ROLES),
        buildingId: shared ? null : random.pick(buildingIds),
        monthlySalary: salaryPaise,
        active: random.chance(0.93),
        joinDate: monthKeyToUtcDate(joinMonth),
        endDate: null,
        notes: null,
        archivedAt: null,
      },
      joinMonth,
      salaryPaise,
    });
  }
  return staff;
}

function generateSalaryPayments(
  staff: readonly GeneratedStaff[],
  months: MonthKey[],
  random: Random,
  userIds: string[],
  today: IsoDate,
): Prisma.SalaryPaymentCreateManyInput[] {
  const rows: Prisma.SalaryPaymentCreateManyInput[] = [];
  const currentMonth = months[months.length - 1]!;

  for (const member of staff) {
    for (const month of months) {
      if (month < member.joinMonth) continue;
      // Salaries for the current month are usually still pending.
      if (month === currentMonth && random.chance(0.75)) continue;
      if (random.chance(0.06)) continue;

      const paidOn = dayInMonth(nextMonthKey(month), random, today);
      if (paidOn > today) continue;

      const method = random.weighted(PAYMENT_METHODS, PAYMENT_METHOD_WEIGHTS);
      rows.push({
        id: newId(),
        staffId: member.row.id!,
        salaryMonth: monthKeyToUtcDate(month),
        amount: member.salaryPaise,
        paymentDate: isoDateToUtcDate(paidOn),
        paymentMethod: method as PaymentMethodLiteral,
        note: null,
        createdById: random.pick(userIds),
        createdAt: isoDateToUtcDate(paidOn),
        updatedAt: isoDateToUtcDate(paidOn),
      });
    }
  }
  return rows;
}

function generateExpenses(
  config: ScaleConfig,
  random: Random,
  buildingIds: string[],
  categories: { id: string; slug: string }[],
  months: MonthKey[],
  userIds: string[],
  today: IsoDate,
): Prisma.ExpenseCreateManyInput[] {
  const rows: Prisma.ExpenseCreateManyInput[] = [];
  const categoryWeights = categories.map((category) => CATEGORY_RANGES[category.slug]?.weight ?? 8);

  for (let index = 0; index < config.expenses; index += 1) {
    const category = random.weighted(categories, categoryWeights);
    const range = CATEGORY_RANGES[category.slug] ?? { min: 500, max: 15_000, weight: 8 };
    const month = random.pick(months);
    const date = dayInMonth(month, random, today);

    rows.push({
      id: newId(),
      date: isoDateToUtcDate(date),
      // A shared bill has no building; the dashboard keeps those in their own
      // row rather than spreading them across the blocks.
      buildingId: random.chance(0.15) ? null : random.pick(buildingIds),
      categoryId: category.id,
      amount: rupeesToPaise(random.int(range.min, range.max)),
      vendor: random.chance(0.85) ? random.pick(VENDORS) : null,
      referenceNumber: random.chance(0.4) ? `INV${random.int(10_000, 999_999)}` : null,
      note: random.chance(0.25) ? `${category.slug.replace(/-/g, ' ')} for the month` : null,
      createdById: random.pick(userIds),
      createdAt: isoDateToUtcDate(date),
      updatedAt: isoDateToUtcDate(date),
    });
  }
  return rows;
}

const AUDIT_ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'ARCHIVE', 'RESTORE', 'MOVE', 'LOGIN'] as const;

function generateAuditLogs(
  config: ScaleConfig,
  random: Random,
  userIds: string[],
  entityIds: { residents: string[]; expenses: string[]; payments: string[] },
  months: MonthKey[],
  today: IsoDate,
): Prisma.AuditLogCreateManyInput[] {
  const rows: Prisma.AuditLogCreateManyInput[] = [];
  const kinds = ['RESIDENT', 'FEE_PAYMENT', 'EXPENSE', 'USER'] as const;
  const kindWeights = [30, 40, 20, 10] as const;

  for (let index = 0; index < config.auditLogs; index += 1) {
    const entityType = random.weighted(kinds, kindWeights);
    const pool =
      entityType === 'RESIDENT'
        ? entityIds.residents
        : entityType === 'FEE_PAYMENT'
          ? entityIds.payments
          : entityType === 'EXPENSE'
            ? entityIds.expenses
            : userIds;
    if (pool.length === 0) continue;

    const at = dayInMonth(random.pick(months), random, today);
    rows.push({
      id: newId(),
      userId: random.pick(userIds),
      action: random.pick(AUDIT_ACTIONS),
      entityType,
      entityId: random.pick(pool),
      summary: `${entityType.toLowerCase().replace(/_/g, ' ')} changed`,
      createdAt: isoDateToUtcDate(at),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

interface UserPlan {
  name: string;
  email: string;
  role: LoadTestRole;
  password: string;
}

function planUsers(config: ScaleConfig): UserPlan[] {
  const plans: UserPlan[] = [];
  for (let index = 0; index < config.users; index += 1) {
    plans.push({
      name: loadTestName(index),
      email: loadTestEmail(index),
      role: loadTestRole(index),
      password: LOAD_TEST_PASSWORD,
    });
  }
  return plans;
}

/**
 * Hash in small groups.
 *
 * scrypt at N=2^15 costs ~32 MB and ~100 ms and runs on the libuv thread pool
 * (four threads), so a Promise.all over fifty accounts would allocate 1.6 GB of
 * scrypt buffers to do exactly the same work in the same time.
 */
async function hashAll(plans: readonly UserPlan[]): Promise<Prisma.UserCreateManyInput[]> {
  const rows: Prisma.UserCreateManyInput[] = [];
  const groupSize = 4;
  const now = new Date();

  for (let start = 0; start < plans.length; start += groupSize) {
    const group = plans.slice(start, start + groupSize);
    const hashes = await Promise.all(group.map((plan) => hashPassword(plan.password)));
    group.forEach((plan, offset) => {
      rows.push({
        id: newId(),
        name: plan.name,
        email: plan.email.toLowerCase(),
        passwordHash: hashes[offset]!,
        role: plan.role,
        active: true,
        mustChangePassword: false,
        tokenValidFrom: now,
        failedLoginAttempts: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

export async function runScaleSeed(options: SeedOptions, target: Target): Promise<void> {
  const db = new PrismaClient({ datasources: { db: { url: target.url } } });
  const random = makeRandom(options.seed);
  const today = todayIso(APP_TIMEZONE);
  const currentMonth = currentMonthKey(APP_TIMEZONE);
  const months = historyMonths(currentMonth, options.months);

  console.info('');
  console.info(`Writing to ${target.database} on ${target.host}`);
  console.info(`Payment history: ${months[0]} .. ${months[months.length - 1]} (${months.length} months)`);
  console.info('');
  console.info('  phase                           rows       time');
  console.info('  ------------------------------------------------');

  try {
    await phase('drop collections', async () => ({ value: null, rows: await dropCollections(db) }));
    await phase('create indexes', async () => ({ value: null, rows: await createIndexes(db) }));

    await phase('settings', async () => {
      await db.hostelSettings.create({
        data: {
          singleton: true,
          hostelName: 'Hostel Manager (scale test)',
          currency: DEFAULT_CURRENCY_SYMBOL,
          currencyCode: DEFAULT_CURRENCY_CODE,
          defaultDueDay: DEFAULT_DUE_DAY,
          timezone: APP_TIMEZONE,
        },
      });
      return { value: null, rows: 1 };
    });

    const categories = await phase('expense categories', async () => {
      const rows = DEFAULT_EXPENSE_CATEGORIES.map((category) => ({
        id: newId(),
        slug: category.slug,
        name: category.name,
        sortOrder: category.sortOrder,
        active: true,
      }));
      await db.expenseCategory.createMany({ data: rows });
      return { value: rows, rows: rows.length };
    });

    const buildingIds = await phase('buildings', async () => {
      const rows: Prisma.BuildingCreateManyInput[] = Array.from(
        { length: options.buildings },
        (_, index) => {
          const seed = BUILDING_SEEDS[index];
          return {
            id: newId(),
            name: seed?.name ?? `Block ${index + 1}`,
            code: seed?.code ?? `B${index + 1}`,
            address: seed?.address ?? null,
            active: true,
            sortOrder: (index + 1) * 10,
          };
        },
      );
      await db.building.createMany({ data: rows });
      return { value: rows.map((row) => row.id!), rows: rows.length };
    });

    const userIds = await phase('users (scrypt hashing)', async () => {
      const rows = await hashAll(planUsers(options));
      await insertBatched(rows, (batch) => db.user.createMany({ data: batch }));
      return { value: rows.map((row) => row.id!), rows: rows.length };
    });

    const staff = await phase('staff', async () => {
      const generated = generateStaff(options, random, buildingIds, months);
      await insertBatched(
        generated.map((member) => member.row),
        (batch) => db.staff.createMany({ data: batch }),
      );
      return { value: generated, rows: generated.length };
    });

    const residents = await phase('residents', async () => {
      const generated = generateResidents(options, random, buildingIds, months, today);
      await insertBatched(
        generated.map((resident) => resident.row),
        (batch) => db.resident.createMany({ data: batch }),
      );
      return { value: generated, rows: generated.length };
    });

    const paymentIds = await phase('fee payments', async () => {
      const rows = generateFeePayments(residents, months, random, userIds, today);
      await insertBatched(rows, (batch) => db.feePayment.createMany({ data: batch }));
      return { value: rows.map((row) => row.id!), rows: rows.length };
    });

    await phase('salary payments', async () => {
      const rows = generateSalaryPayments(staff, months, random, userIds, today);
      await insertBatched(rows, (batch) => db.salaryPayment.createMany({ data: batch }));
      return { value: null, rows: rows.length };
    });

    const expenseIds = await phase('expenses', async () => {
      const rows = generateExpenses(
        options,
        random,
        buildingIds,
        categories,
        months,
        userIds,
        today,
      );
      await insertBatched(rows, (batch) => db.expense.createMany({ data: batch }));
      return { value: rows.map((row) => row.id!), rows: rows.length };
    });

    await phase('audit log', async () => {
      const rows = generateAuditLogs(
        options,
        random,
        userIds,
        {
          residents: residents.map((resident) => resident.row.id!),
          expenses: expenseIds,
          payments: paymentIds,
        },
        months,
        today,
      );
      await insertBatched(rows, (batch) => db.auditLog.createMany({ data: batch }));
      return { value: null, rows: rows.length };
    });

    await reportFinalState(db, target, months);
  } finally {
    await db.$disconnect();
  }
}

/** What the database actually holds, read back rather than assumed. */
async function reportFinalState(db: PrismaClient, target: Target, months: MonthKey[]): Promise<void> {
  const [buildings, residentCount, stayingCount, payments, staffCount, salaries, expenses, users, audits] =
    await Promise.all([
      db.building.count(),
      db.resident.count(),
      db.resident.count({ where: { active: true, OR: [{ vacatedDate: null }, { vacatedDate: { gte: new Date() } }] } }),
      db.feePayment.count(),
      db.staff.count(),
      db.salaryPayment.count(),
      db.expense.count(),
      db.user.count(),
      db.auditLog.count(),
    ]);

  const stats = (await db.$runCommandRaw({ dbStats: 1, scale: 1_048_576 })) as unknown as {
    dataSize?: number;
    storageSize?: number;
    indexSize?: number;
  };

  const totalMs = phases.reduce((sum, entry) => sum + entry.ms, 0);
  const totalRows = phases.reduce((sum, entry) => sum + entry.rows, 0);

  console.info('  ------------------------------------------------');
  console.info(
    `  ${'TOTAL'.padEnd(26)} ${formatCount(totalRows).padStart(9)} rows  ${formatMs(totalMs).padStart(9)}`,
  );
  console.info('');
  console.info('FINAL COUNTS (read back from the database)');
  console.info(`  buildings          ${formatCount(buildings)}`);
  console.info(`  residents          ${formatCount(residentCount)}  (${formatCount(stayingCount)} currently staying)`);
  console.info(`  fee payments       ${formatCount(payments)}  over ${months.length} months`);
  console.info(`  staff              ${formatCount(staffCount)}`);
  console.info(`  salary payments    ${formatCount(salaries)}`);
  console.info(`  expenses           ${formatCount(expenses)}`);
  console.info(`  users              ${formatCount(users)}`);
  console.info(`  audit log entries  ${formatCount(audits)}`);
  console.info('');
  console.info(
    `  data ${(stats.dataSize ?? 0).toFixed(1)} MB   storage ${(stats.storageSize ?? 0).toFixed(1)} MB   ` +
      `indexes ${(stats.indexSize ?? 0).toFixed(1)} MB`,
  );
  console.info('');
  console.info('NEXT');
  console.info('  1. Start the API against this database:');
  console.info('');
  console.info(`       DATABASE_URL='${redact(target.url)}' \\`);
  console.info("       RATE_LIMIT_MAX_REQUESTS=2000000 npx next dev --port 4100");
  console.info('');
  console.info('     (the rate-limit override is required - see the note in scripts/load-test.ts)');
  console.info('  2. Run the load test:');
  console.info('');
  console.info('       npx tsx scripts/load-test.ts --url http://localhost:4100');
  console.info('');
  console.info(`  Accounts: ${loadTestEmail(0)} .. ${loadTestEmail(users - 1)}, password ${LOAD_TEST_PASSWORD}`);
  console.info('  These are fixtures with a published password. They exist only in the scale database.');
  console.info('');
}

/** Never print the cluster password, not even from a fixture script. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function loadLocalEnv(): void {
  // tsx does not read .env.local the way `next dev` and the Prisma CLI do.
  // process.loadEnvFile leaves variables already present in the environment
  // alone, so `DATABASE_URL=... npx tsx ...` still wins.
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Absent or unreadable: the environment may already carry the values.
    }
  }
}

function printPlan(options: SeedOptions, target: Target): void {
  console.info('');
  console.info('SCALE-TEST DATA GENERATOR');
  console.info('=========================');
  console.info(`  cluster            ${target.host}`);
  console.info(`  live database      ${target.liveDatabase}   (NOT touched)`);
  console.info(`  target database    ${target.database}`);
  console.info('');
  console.info('  It will DROP and regenerate these collections in the target database:');
  console.info(`    ${COLLECTIONS.join(', ')}`);
  console.info('');
  console.info('  Planned volume');
  console.info(`    buildings        ${formatCount(options.buildings)}`);
  console.info(`    residents        ${formatCount(options.residents)}`);
  console.info(`    payment history  ${options.months} months (with realistic gaps)`);
  console.info(`    staff            ${formatCount(options.staff)}`);
  console.info(`    expenses         ${formatCount(options.expenses)}`);
  console.info(`    users            ${formatCount(options.users)}`);
  console.info(`    audit entries    ${formatCount(options.auditLogs)}`);
  console.info(`    seed             ${options.seed} (deterministic)`);
  console.info('');
}

async function main(): Promise<void> {
  loadLocalEnv();

  const options = parseSeedArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Put it in backend/.env.local or pass it in the environment.',
    );
  }

  const target = resolveTarget(databaseUrl, options.database, options.allowAnyName);
  printPlan(options, target);

  if (!options.confirmed) {
    console.info('  Nothing was written. Re-run with --yes to proceed:');
    console.info('');
    console.info(`    npm run seed:scale -- --yes${options.database ? ` --database=${options.database}` : ''}`);
    console.info('');
    process.exitCode = 1;
    return;
  }

  await runScaleSeed(options, target);
}

/** Only run when executed directly, so tests can import the guards. */
const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  return typeof entry === 'string' && /seed-scale-data\.(ts|js|mjs)$/.test(entry.replace(/\\/g, '/'));
};

if (invokedDirectly()) {
  main().catch((error: unknown) => {
    console.error('');
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    process.exitCode = 1;
  });
}
