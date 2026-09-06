/**
 * Creates one account per role, for trying the application out.
 *
 * Passwords are GENERATED, not hardcoded. An earlier version of this script
 * carried fixed passwords in the source, which is fine on a laptop and quietly
 * dangerous the moment the repository is pushed anywhere: anyone reading it
 * would know how to sign in to every deployment that had ever run it.
 *
 * The generated passwords are printed once, here, and nowhere else. Pass
 * DEMO_PASSWORD to use a known one instead - useful for a scripted test, and
 * still never committed.
 *
 *   npx tsx scripts/create-demo-accounts.ts
 *   DEMO_PASSWORD='Something#Strong99' npx tsx scripts/create-demo-accounts.ts
 *   npx tsx scripts/create-demo-accounts.ts --remove
 *
 * These are DEMONSTRATION accounts. Remove them before the instance holds
 * anything you care about, and create real ones through Settings instead.
 */
import { prisma } from '../lib/db/prisma';
import {
  generateTemporaryPassword,
  hashPassword,
  validatePasswordStrength,
} from '../lib/auth/password';
import type { UserRole } from '@hostel/shared';

const ACCOUNTS: { name: string; email: string; role: UserRole }[] = [
  { name: 'Hostel Owner', email: 'owner@nhhostel.in', role: 'OWNER' },
  { name: 'Hostel Admin', email: 'admin@nhhostel.in', role: 'ADMIN' },
  // DEVELOPER has ADMIN-level create/update access plus the activity log and
  // diagnostics - the role for answering "who changed this, and when?".
  { name: 'Support Engineer', email: 'developer@nhhostel.in', role: 'DEVELOPER' },
  { name: 'Front Desk', email: 'manager@nhhostel.in', role: 'MANAGER' },
  { name: 'Accountant', email: 'viewer@nhhostel.in', role: 'VIEWER' },
];

/**
 * A password that satisfies the real policy, so the holder can later change it
 * through the UI without being told their current one was never valid.
 */
function makePassword(): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `${generateTemporaryPassword()}#Aa1`;
    if (validatePasswordStrength(candidate).length === 0) return candidate;
  }
  throw new Error('Could not generate a password satisfying the policy');
}

async function main(): Promise<void> {
  const emails = ACCOUNTS.map((account) => account.email);

  if (process.argv.includes('--remove')) {
    const { count } = await prisma.user.deleteMany({ where: { email: { in: emails } } });
    console.info(`Removed ${count} demonstration account(s).`);
    return;
  }

  const shared = process.env.DEMO_PASSWORD;
  if (shared) {
    const problems = validatePasswordStrength(shared);
    if (problems.length) throw new Error(`DEMO_PASSWORD is not acceptable: ${problems.join('; ')}`);
  }

  const issued: { role: UserRole; email: string; password: string }[] = [];

  for (const account of ACCOUNTS) {
    const password = shared ?? makePassword();
    const passwordHash = await hashPassword(password);

    await prisma.user.upsert({
      where: { email: account.email },
      update: {
        name: account.name,
        role: account.role,
        passwordHash,
        active: true,
        // These exist to be signed into immediately, so no forced change.
        mustChangePassword: false,
        // Ends any session issued against the previous password.
        tokenValidFrom: new Date(),
      },
      create: {
        name: account.name,
        email: account.email,
        role: account.role,
        passwordHash,
        active: true,
        mustChangePassword: false,
      },
    });

    issued.push({ role: account.role, email: account.email, password });
  }

  const width = Math.max(...issued.map((entry) => entry.email.length));
  console.info('\nDemonstration accounts (shown once - nothing stores these):\n');
  for (const entry of issued) {
    console.info(`  ${entry.role.padEnd(10)}${entry.email.padEnd(width + 2)}${entry.password}`);
  }
  console.info('\nSign in at the web app. Remove them with --remove before real use.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
