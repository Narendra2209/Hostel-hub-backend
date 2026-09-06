/**
 * Delete every business record, keeping configuration and accounts.
 *
 * This is what you run before entering your own register: it empties residents,
 * buildings, staff, payments, expenses, tickets and the audit trail, and leaves
 * behind the things you would only have to recreate by hand -
 *
 *   kept     hostel settings, expense categories, user accounts, GridFS files
 *            belonging to residents that survive (there are none after a full
 *            reset, so orphans are cleaned up too)
 *   deleted  residents, buildings, fee payments, staff, salary payments,
 *            expenses, resident move history, tickets, ticket comments,
 *            audit logs
 *
 * Deliberately NOT a "drop the database" script. Dropping would take the
 * settings singleton, the categories and every login with it, and the next
 * person to open the app would be met with the first-run setup screen wondering
 * where their account went.
 *
 *   npx tsx scripts/reset-business-data.ts            # dry run, shows counts
 *   npx tsx scripts/reset-business-data.ts --yes      # actually delete
 *   npx tsx scripts/reset-business-data.ts --yes --keep-audit
 */
import { MongoClient } from 'mongodb';
import { prisma } from '../lib/db/prisma';
import { env } from '../lib/env';

const args = new Set(process.argv.slice(2));
const confirmed = args.has('--yes');
const keepAudit = args.has('--keep-audit');

/** Children before parents, so nothing is ever orphaned mid-run. */
const ORDER = [
  'ticket comments',
  'tickets',
  'fee payments',
  'salary payments',
  'resident move history',
  'expenses',
  'residents',
  'staff',
  'buildings',
] as const;

async function countAll(): Promise<Record<string, number>> {
  const [
    ticketComments,
    tickets,
    feePayments,
    salaryPayments,
    moves,
    expenses,
    residents,
    staff,
    buildings,
    auditLogs,
    users,
    categories,
  ] = await Promise.all([
    prisma.ticketComment.count(),
    prisma.ticket.count(),
    prisma.feePayment.count(),
    prisma.salaryPayment.count(),
    prisma.residentBuildingHistory.count(),
    prisma.expense.count(),
    prisma.resident.count(),
    prisma.staff.count(),
    prisma.building.count(),
    prisma.auditLog.count(),
    prisma.user.count(),
    prisma.expenseCategory.count(),
  ]);

  return {
    'ticket comments': ticketComments,
    tickets,
    'fee payments': feePayments,
    'salary payments': salaryPayments,
    'resident move history': moves,
    expenses,
    residents,
    staff,
    buildings,
    'audit logs': auditLogs,
    users,
    'expense categories': categories,
  };
}

/**
 * Resident photographs and Aadhaar scans live in GridFS, outside Prisma's
 * knowledge. Deleting the residents alone would leave their files behind
 * forever, silently consuming the cluster's storage quota.
 */
async function purgeDocuments(): Promise<number> {
  const client = new MongoClient(env().DATABASE_URL);
  try {
    await client.connect();
    const db = client.db();
    const files = await db.collection('documents.files').countDocuments();
    if (files > 0) {
      await db.collection('documents.chunks').deleteMany({});
      await db.collection('documents.files').deleteMany({});
    }
    return files;
  } catch {
    // The bucket may not exist yet if nobody has ever uploaded anything.
    return 0;
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const before = await countAll();

  console.info('Business records currently in the database:');
  for (const key of ORDER) console.info(`  ${key.padEnd(24)}${before[key]}`);
  console.info(`  ${'audit logs'.padEnd(24)}${before['audit logs']}`);
  console.info('\nKept regardless:');
  console.info(`  ${'user accounts'.padEnd(24)}${before.users}`);
  console.info(`  ${'expense categories'.padEnd(24)}${before['expense categories']}`);
  console.info(`  ${'hostel settings'.padEnd(24)}1`);

  if (!confirmed) {
    console.info('\nDry run - nothing was deleted. Re-run with --yes to proceed.');
    return;
  }

  console.info('\nDeleting...');
  // Not wrapped in one transaction on purpose: MongoDB aborts a transaction
  // after 60 seconds, and a large register would exceed that. Each step is
  // independent and idempotent, so a failure part-way can simply be re-run.
  const deleted: Record<string, number> = {};
  deleted['ticket comments'] = (await prisma.ticketComment.deleteMany({})).count;
  deleted.tickets = (await prisma.ticket.deleteMany({})).count;
  deleted['fee payments'] = (await prisma.feePayment.deleteMany({})).count;
  deleted['salary payments'] = (await prisma.salaryPayment.deleteMany({})).count;
  deleted['resident move history'] = (await prisma.residentBuildingHistory.deleteMany({})).count;
  deleted.expenses = (await prisma.expense.deleteMany({})).count;
  deleted.residents = (await prisma.resident.deleteMany({})).count;
  deleted.staff = (await prisma.staff.deleteMany({})).count;
  deleted.buildings = (await prisma.building.deleteMany({})).count;

  const files = await purgeDocuments();
  if (files > 0) console.info(`  ${'stored documents'.padEnd(24)}${files}`);

  if (!keepAudit) {
    // The audit trail describes records that no longer exist; keeping it would
    // leave an activity log full of entries pointing at nothing.
    deleted['audit logs'] = (await prisma.auditLog.deleteMany({})).count;
  }

  for (const [key, value] of Object.entries(deleted)) {
    console.info(`  removed ${String(value).padStart(6)}  ${key}`);
  }

  const after = await countAll();
  const remaining = ORDER.reduce((total, key) => total + after[key]!, 0);
  console.info(
    remaining === 0
      ? '\nEvery business record is gone. Settings, categories and logins are intact.'
      : `\nWARNING: ${remaining} business record(s) still present.`,
  );
  console.info('The app now shows its empty states; add a building first, then residents.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
