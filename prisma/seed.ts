/**
 * DEVELOPMENT SEED - CONFIGURATION ONLY.
 *
 * This script creates no business data. It creates no residents, no payments,
 * no staff, no expenses and no buildings - because none of those are things the
 * software knows, they are things the hostel owner knows.
 *
 * All it does is make the two *configuration* rows explicit on a fresh
 * database: the single hostel settings row and the default expense categories.
 * Even that is a convenience rather than a requirement - the API bootstraps
 * both on first read (see lib/services/settings.service.ts), so every screen
 * works correctly against a database that has only ever had `prisma db push`
 * run against it - and, MongoDB being schemaless, against one where not even
 * that has happened and the collections do not yet exist. An empty database is
 * a valid, fully functional state: the dashboard shows zeroes, the lists show
 * their empty states, and the first resident the owner adds is the first
 * document in the collection.
 *
 * The historical August 2026 register from the original single-file
 * application is *not* part of this seed. It is historical business data that
 * lives in `scripts/legacy-data.json`, is loaded once by
 * `scripts/import-legacy-data.ts`, and thereafter lives in MongoDB. No
 * application code may reference that file or the values inside it. Pass
 * `--with-legacy` here only if you want that one-off migration run for you.
 *
 * USAGE
 * -----
 *   npm run prisma:seed                        # configuration only
 *   npm run prisma:seed -- --with-legacy       # ...and import the old register
 *   npm run prisma:seed -- --with-legacy --dry-run
 */
import { prisma } from '../lib/db/prisma';
import { ensureDefaultCategories, getSettings } from '../lib/services/settings.service';
import { parseLegacyArgs, runLegacyImport } from '../scripts/import-legacy-data';

const WITH_LEGACY_FLAG = '--with-legacy';

async function seedConfiguration(): Promise<void> {
  // Idempotent: `singleton` carries a unique index, so a second settings
  // document is impossible even if this runs twice.
  const settings = await getSettings();
  console.info(
    `[seed] Settings ready: "${settings.hostelName}", ${settings.currency} (${settings.currencyCode}), ` +
      `default due day ${settings.defaultDueDay}, timezone ${settings.timezone}`,
  );

  // Only fills an empty collection, so categories the owner has renamed or
  // added are never clobbered.
  await ensureDefaultCategories();
  const categories = await prisma.expenseCategory.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { name: true },
  });
  console.info(
    `[seed] Expense categories ready (${categories.length}): ` +
      categories.map((category) => category.name).join(', '),
  );
}

/** What the database actually holds, so the seed never has to claim anything. */
async function reportBusinessData(): Promise<void> {
  const [buildings, residents, feePayments, staff, expenses] = await Promise.all([
    prisma.building.count(),
    prisma.resident.count(),
    prisma.feePayment.count(),
    prisma.staff.count(),
    prisma.expense.count(),
  ]);

  console.info('');
  console.info('[seed] Business data currently in the database:');
  console.info(`         buildings ${buildings}   residents ${residents}   fee payments ${feePayments}`);
  console.info(`         staff ${staff}   expenses ${expenses}`);

  if (buildings === 0 && residents === 0 && expenses === 0) {
    console.info('');
    console.info('       That is a perfectly valid state. The application is designed to run');
    console.info('       against an empty database: add a building, add a resident, and the');
    console.info('       ledger, arrears and profit-and-loss screens fill themselves in.');
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const withLegacy = argv.includes(WITH_LEGACY_FLAG);

  console.info('[seed] Seeding configuration only - no residents, payments or expenses.');
  await seedConfiguration();

  if (!withLegacy) {
    await reportBusinessData();
    console.info('');
    console.info('[seed] Done.');
    console.info(
      `[seed] The historical August 2026 register is optional: run "npm run prisma:seed -- ${WITH_LEGACY_FLAG}"`,
    );
    console.info('       or "npm run import:legacy" to load it. The application does not need it.');
    console.info('');
    return;
  }

  console.info('');
  console.info(`[seed] ${WITH_LEGACY_FLAG} given - delegating to the one-off legacy register import.`);
  console.info('       This is historical data only. It is never required for the app to work.');
  console.info('');

  // The importer owns its own production guard, validation, transaction and
  // created/skipped reporting; the seed only forwards the flags.
  await runLegacyImport(parseLegacyArgs(argv));

  await reportBusinessData();
  console.info('');
  console.info('[seed] Done.');
  console.info('');
}

main()
  .catch((error: unknown) => {
    console.error('');
    console.error('[seed] FAILED');
    console.error(error instanceof Error ? error.message : error);
    console.error('');
    process.exitCode = 1;
  })
  // Best-effort: the client is built lazily, so a run that failed before ever
  // reaching the database must not fail a second time on the way out.
  .finally(() => prisma.$disconnect().catch(() => undefined));
