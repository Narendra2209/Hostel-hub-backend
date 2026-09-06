/**
 * Sign-in, first-run bootstrap and password changes.
 *
 * This replaces Cognito. Everything an identity provider used to do now happens
 * here, against the `users` collection:
 *
 *  * Passwords are scrypt hashes (see `lib/auth/password.ts`). The plaintext
 *    exists only inside the request that carried it - never in the database,
 *    never in a log line, never in an audit payload.
 *  * A session is a signed JWT carrying nothing but the user id
 *    (`lib/auth/jwt.ts`). The role is read from the User document on every
 *    request, so a demotion takes effect immediately.
 *  * Revocation without a session store is `tokenValidFrom`: bumping it makes
 *    every token minted before that instant invalid.
 *
 * Two attacks shaped the code below and are worth keeping in mind before
 * changing it:
 *
 *  * **Account enumeration.** An unknown email and a wrong password must be
 *    indistinguishable - the same message, and roughly the same response time.
 *    That is why the "no such user" path still verifies against a decoy hash
 *    rather than returning early.
 *  * **Online guessing.** Consecutive failures lock the account for
 *    LOGIN_LOCKOUT_MINUTES, which is the one place the API does admit that an
 *    address is registered; it is a deliberate trade, because a lockout the
 *    user cannot see the reason for is worse than useless.
 */
import { randomBytes } from 'node:crypto';
import type {
  AuthStatusDto,
  BootstrapInput,
  ChangePasswordInput,
  LoginInput,
  LoginResponseDto,
} from '@hostel/shared';
import { DEFAULT_HOSTEL_NAME } from '@hostel/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { env } from '../env';
import { AppError, ConflictError, ForbiddenError, UnauthorizedError, ValidationError } from '../errors/app-error';
import { hasAnyUser, toCurrentUserDto, type AuthContext } from '../auth/context';
import { createSessionToken } from '../auth/jwt';
import { hashPassword, needsRehash, validatePasswordStrength, verifyPassword } from '../auth/password';
import { logger } from '../http/logger';
import { recordAudit } from './audit.service';
import { getSettings } from './settings.service';
import {
  isTransactionConflict,
  serialiseAccountChange,
  toUserDto,
  userSelect,
  type UserRow,
} from './user.service';

/**
 * The projection the sign-in paths need: the display fields plus the two the
 * rest of the application must never see - the hash and the lock expiry.
 */
const credentialSelect = {
  ...userSelect,
  passwordHash: true,
  lockedUntil: true,
} satisfies Prisma.UserSelect;

type CredentialRow = Prisma.UserGetPayload<{ select: typeof credentialSelect }>;

const toAuthContext = (user: UserRow): AuthContext => ({
  userId: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  active: user.active,
  mustChangePassword: user.mustChangePassword,
});

const invalidCredentials = (): AppError =>
  new AppError(401, 'INVALID_CREDENTIALS', 'That email address or password is not correct.');

const alreadyBootstrapped = (): ConflictError =>
  new ConflictError(
    'This hostel has already been set up. Sign in with an existing account instead.',
    'ALREADY_BOOTSTRAPPED',
  );

/**
 * A hash of a password nobody knows, used to keep the "unknown email" path as
 * expensive as the "wrong password" one.
 *
 * Built once per container and cached as a promise, so the second and every
 * later miss costs exactly one scrypt verification - the same as a real user
 * typing the wrong password.
 */
let decoyHash: Promise<string> | null = null;
function decoy(): Promise<string> {
  decoyHash ??= hashPassword(randomBytes(24).toString('base64url'));
  return decoyHash;
}

/** Mint a session for a user and shape the response the client expects. */
async function issueSession(user: UserRow): Promise<LoginResponseDto> {
  const { token, expiresAt } = await createSessionToken(user.id);
  return {
    user: toCurrentUserDto(toAuthContext(user)),
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Refusal message for a locked account, with a Retry-After the client can obey.
 * 429 rather than 401 because this *is* a rate limit, just a per-account one.
 */
function accountLocked(lockedUntil: Date): AppError {
  const seconds = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return new AppError(
    429,
    'ACCOUNT_LOCKED',
    `Too many failed sign-in attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
    { logContext: { retryAfterSeconds: seconds } },
  );
}

/* ------------------------------------------------------------------ *
 * First run
 * ------------------------------------------------------------------ */

/**
 * What the login screen needs before anybody has signed in.
 *
 * Must work against a completely empty database, so it only ever reads: on a
 * virgin cluster the collections do not exist yet, `count` is 0 and `findFirst`
 * is null. Creating the settings document is left to the first authenticated
 * read, so an anonymous request can never write.
 */
export async function getAuthStatus(): Promise<AuthStatusDto> {
  const [anyUser, settings] = await Promise.all([
    hasAnyUser(),
    prisma.hostelSettings.findFirst({ select: { hostelName: true } }),
  ]);

  return {
    needsBootstrap: !anyUser,
    hostelName: settings?.hostelName ?? DEFAULT_HOSTEL_NAME,
  };
}

/**
 * Create the very first account, as OWNER, and sign it in.
 *
 * Open to anonymous callers by necessity - there is nobody to authenticate as
 * yet - so "the users collection is empty" is the *only* thing standing between
 * a stranger and an owner account. That check therefore runs again inside the
 * transaction, and the transaction takes the account lock so two simultaneous
 * requests cannot both find the collection empty and both create an owner.
 */
export async function bootstrap(input: BootstrapInput): Promise<LoginResponseDto> {
  const problems = validatePasswordStrength(input.password);
  if (problems.length > 0) {
    throw new ValidationError('That password is not strong enough', { password: problems });
  }

  // Cheap rejection for the common case, so a repeated call does not pay for a
  // scrypt hash it will throw away.
  if (await hasAnyUser()) throw alreadyBootstrapped();

  // Outside the transaction: hashing takes ~100ms and the settings document has
  // to exist before it can be used as the lock.
  await getSettings();
  const passwordHash = await hashPassword(input.password);

  let created: UserRow;
  try {
    created = await prisma.$transaction(async (tx) => {
      await serialiseAccountChange(tx);
      if ((await tx.user.count()) > 0) throw alreadyBootstrapped();

      if (input.hostelName) {
        const settings = await getSettings(tx);
        await tx.hostelSettings.update({
          where: { id: settings.id },
          data: { hostelName: input.hostelName },
        });
      }

      const user = await tx.user.create({
        data: {
          name: input.name,
          email: input.email,
          passwordHash,
          role: 'OWNER',
          active: true,
          // The first owner chose this password themselves; nothing to force.
          mustChangePassword: false,
        },
        select: userSelect,
      });

      // The new owner is the actor: they created themselves.
      await recordAudit(tx, {
        auth: toAuthContext(user),
        action: 'CREATE',
        entityType: 'USER',
        entityId: user.id,
        summary: input.hostelName
          ? `${user.name} set up "${input.hostelName}" and became the first owner`
          : `${user.name} became the first owner`,
        newData: toUserDto(user),
      });

      return user;
    });
  } catch (error) {
    // Lost the write-write race for the settings document: the other request
    // is the one that created the owner.
    if (isTransactionConflict(error)) throw alreadyBootstrapped();
    throw error;
  }

  logger.info('Hostel bootstrapped', { userId: created.id });
  return issueSession(created);
}

/* ------------------------------------------------------------------ *
 * Sign in
 * ------------------------------------------------------------------ */

/**
 * Count a failed attempt and lock the account once it reaches the limit.
 *
 * The increment is an atomic `$inc` rather than a read-modify-write, so a burst
 * of parallel guesses is counted in full instead of collapsing into one.
 * Returns the lock expiry when this attempt was the one that locked it.
 */
async function registerFailedAttempt(userId: string): Promise<Date | null> {
  const { LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_MINUTES } = env();

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginAttempts: { increment: 1 } },
    select: { failedLoginAttempts: true },
  });

  if (updated.failedLoginAttempts < LOGIN_MAX_ATTEMPTS) return null;

  const lockedUntil = new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60_000);
  // The counter resets with the lock, so the window after it expires starts
  // from zero rather than locking again on the very next mistake.
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginAttempts: 0, lockedUntil },
  });
  return lockedUntil;
}

/**
 * Verify an email and password and start a session.
 *
 * The order of the checks is deliberate: lockout, then password, then whether
 * the account is active. Checking `active` last means a wrong password on a
 * deactivated account still answers "email or password is not correct" rather
 * than confirming the address exists.
 */
export async function login(input: LoginInput): Promise<LoginResponseDto> {
  // Warm the decoy before the lookup so the unknown-email path is not slower
  // simply because it had to build one.
  const decoyPromise = decoy();

  const user: CredentialRow | null = await prisma.user.findUnique({
    where: { email: input.email },
    select: credentialSelect,
  });

  if (!user) {
    // Spend the same ~100ms a real verification costs, then answer identically.
    await verifyPassword(input.password, await decoyPromise);
    logger.warn('Sign-in attempt for an unknown account');
    throw invalidCredentials();
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    logger.warn('Sign-in attempt on a locked account', { userId: user.id });
    throw accountLocked(user.lockedUntil);
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    const lockedUntil = await registerFailedAttempt(user.id);
    logger.warn('Failed sign-in', { userId: user.id, locked: lockedUntil !== null });
    if (lockedUntil) throw accountLocked(lockedUntil);
    throw invalidCredentials();
  }

  if (!user.active) {
    throw new ForbiddenError('This account has been deactivated. Ask an owner to re-enable it.');
  }

  /*
   * Transparent upgrade: the stored hash was made with weaker parameters than
   * the current policy, and this is the only moment the plaintext is available
   * to re-derive it. Not a reason to bump `tokenValidFrom` - the password has
   * not changed, so other sessions stay valid.
   */
  const upgradedHash = needsRehash(user.passwordHash)
    ? await hashPassword(input.password)
    : undefined;

  const signedIn = await prisma.$transaction(async (tx) => {
    const row = await tx.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        ...(upgradedHash ? { passwordHash: upgradedHash } : {}),
      },
      select: userSelect,
    });

    await recordAudit(tx, {
      auth: toAuthContext(row),
      action: 'LOGIN',
      entityType: 'SESSION',
      entityId: row.id,
      summary: `${row.name} signed in`,
    });

    return row;
  });

  if (upgradedHash) logger.info('Password hash upgraded on sign-in', { userId: signedIn.id });

  return issueSession(signedIn);
}

/* ------------------------------------------------------------------ *
 * Password change
 * ------------------------------------------------------------------ */

/**
 * A signed-in user replaces their own password.
 *
 * Bumping `tokenValidFrom` signs out every other session, which is the whole
 * point of changing a password you think somebody else knows. The caller would
 * be signed out too, so a fresh token is minted afterwards and returned; it is
 * issued after the write, so its `iat` is never behind the new `tokenValidFrom`.
 */
export async function changePassword(
  auth: AuthContext,
  input: ChangePasswordInput,
): Promise<LoginResponseDto> {
  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: credentialSelect,
  });
  // The account was removed between authenticating and getting here.
  if (!user) throw new UnauthorizedError('Your session is no longer valid. Please sign in again.');

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    logger.warn('Password change refused: current password did not match', { userId: user.id });
    throw new ValidationError('Your current password is not correct', {
      currentPassword: ['That is not your current password'],
    });
  }

  // The shared schema checks the same rules client-side; this is the authority.
  const problems = validatePasswordStrength(input.newPassword);
  if (problems.length > 0) {
    throw new ValidationError('That password is not strong enough', { newPassword: problems });
  }

  const passwordHash = await hashPassword(input.newPassword);

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        tokenValidFrom: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
      select: userSelect,
    });

    await recordAudit(tx, {
      auth,
      action: 'UPDATE',
      entityType: 'USER',
      entityId: row.id,
      // That it happened and who did it. Never what it was changed to.
      summary: `${row.name} changed their own password`,
    });

    return row;
  });

  logger.info('Password changed', { userId: updated.id });
  return issueSession(updated);
}
