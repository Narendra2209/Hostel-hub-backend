/**
 * Application accounts: listing them, inviting colleagues, changing roles and
 * resetting passwords.
 *
 * Sign-in itself lives in `auth.service.ts`; this file owns the *administration*
 * of accounts, which is owner-only work. The two invariants it protects are:
 *
 *  1. Nothing here ever reads a password hash. Every query selects an explicit
 *     field list (`userSelect`) rather than the whole document, so a hash cannot
 *     reach a DTO, a log line or an audit payload by accident. The sign-in path
 *     in `auth.service.ts` is the only code that asks for one.
 *  2. The hostel can never be left without a way in: the last active OWNER
 *     cannot be demoted or deactivated, whoever asks.
 *
 * MongoDB notes
 * -------------
 *  * There are no foreign keys and no `SELECT ... FOR UPDATE`. Invariant (2) is
 *    therefore enforced entirely here, and needs the serialisation described on
 *    `serialiseAccountChange` to survive two simultaneous requests.
 *  * A generated temporary password is returned to the caller exactly once, in
 *    the response body. It is never stored in plaintext and never audited.
 */
import type { z } from 'zod';
import type {
  AuditAction,
  InviteUserInput,
  InvitedUserDto,
  ResetUserPasswordInput,
  UserDto,
  updateUserSchema,
} from '@hostel/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../errors/app-error';
import type { AuthContext } from '../auth/context';
import { generateTemporaryPassword, hashPassword, validatePasswordStrength } from '../auth/password';
import { searchFilter } from '../repositories/filters';
import { recordAudit } from './audit.service';
import { getSettings } from './settings.service';

/**
 * The only projection of a User this application reads for display.
 * `passwordHash`, `tokenValidFrom`, `failedLoginAttempts` and `lockedUntil` are
 * deliberately absent: nothing outside the sign-in path has any use for them.
 */
export const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

/** @hostel/shared exports the schema but not its inferred type. */
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export interface ListUsersQuery {
  page: number;
  pageSize: number;
  search?: string;
  sortOrder: 'asc' | 'desc';
}

const userNotFound = (): NotFoundError => new NotFoundError('User', 'USER_NOT_FOUND');

const duplicateEmail = (): ConflictError =>
  new ConflictError('An account with that email address already exists.', 'DUPLICATE_EMAIL');

export const toUserDto = (user: UserRow): UserDto => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  active: user.active,
  mustChangePassword: user.mustChangePassword,
  lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  createdAt: user.createdAt.toISOString(),
});

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Did this transaction lose a race for the same document?
 *
 * Prisma reports a MongoDB write conflict as P2034, but the driver-level message
 * is matched as well because that mapping is not guaranteed for every failure
 * shape - and getting it wrong would turn a safe, retryable conflict into an
 * opaque 500.
 */
export function isTransactionConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true;
  return error instanceof Error && /write\s?conflict/i.test(error.message);
}

/**
 * Force two concurrent account changes to collide.
 *
 * MongoDB gives snapshot isolation, not serialisability: two transactions that
 * read the same documents and then write *different* ones both commit happily.
 * That is exactly enough to break "there is always one active owner" - each
 * transaction counts the other's owner as still active and lets both demotions
 * through - and "there is only ever one first owner".
 *
 * Writing one shared document creates the conflict the invariant needs. The
 * settings singleton is that document: it always exists, every account-changing
 * transaction touches it, the server detects the write-write conflict, and
 * exactly one of the racing transactions survives. `updatedAt` changes on every
 * update, so this is always a real write and never optimised away.
 */
export async function serialiseAccountChange(tx: Prisma.TransactionClient): Promise<void> {
  const settings = await getSettings(tx);
  await tx.hostelSettings.update({ where: { id: settings.id }, data: { singleton: true } });
}

/**
 * The account list.
 *
 * On PostgreSQL a native enum sorted by declaration order, so `role: 'asc'` put
 * owners first. MongoDB stores an enum as its string value, so the same sort is
 * alphabetical - ADMIN, MANAGER, OWNER, VIEWER. Rows are therefore *grouped* by
 * role rather than ranked by privilege, which is still a stable order to
 * paginate; every row shows its role anyway.
 */
export async function listUsers(
  query: ListUsersQuery,
): Promise<{ items: UserDto[]; total: number }> {
  const search = searchFilter(query.search);
  const where: Prisma.UserWhereInput = search ? { OR: [{ name: search }, { email: search }] } : {};

  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: [{ role: 'asc' }, { name: query.sortOrder }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: userSelect,
    }),
  ]);

  return { items: rows.map(toUserDto), total };
}

/**
 * Invite a colleague.
 *
 * The server generates the password rather than accepting one, so a plaintext
 * password chosen by somebody else never travels in a request body. It is
 * returned once in the response and then forgotten; `mustChangePassword` makes
 * the invitee replace it before they can use the application.
 */
export async function inviteUser(
  input: InviteUserInput,
  auth: AuthContext,
): Promise<InvitedUserDto> {
  // `emailField` in @hostel/shared has already trimmed and lowercased this, and
  // the unique index is on the lowercased value.
  const email = input.email;

  const clash = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (clash) throw duplicateEmail();

  const temporaryPassword = generateTemporaryPassword();
  // Hashing is deliberately slow (~100ms), so it happens before the transaction
  // opens rather than holding one open for the duration.
  const passwordHash = await hashPassword(temporaryPassword);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: input.name,
          email,
          passwordHash,
          role: input.role,
          active: true,
          mustChangePassword: true,
        },
        select: userSelect,
      });

      await recordAudit(tx, {
        auth,
        action: 'CREATE',
        entityType: 'USER',
        entityId: user.id,
        summary: `${auth.name} invited ${user.name} as ${user.role}`,
        // Who was created - never the password, never the hash.
        newData: toUserDto(user),
      });

      return user;
    });

    return { user: toUserDto(created), temporaryPassword };
  } catch (error) {
    // Lost the race with another invitation for the same address.
    if (isUniqueViolation(error)) throw duplicateEmail();
    throw error;
  }
}

/** Which audit action best describes this change. */
function auditActionFor(previous: UserRow, input: UpdateUserInput): AuditAction {
  if (input.active === false && previous.active) return 'ARCHIVE';
  if (input.active === true && !previous.active) return 'RESTORE';
  return 'UPDATE';
}

/**
 * Rename an account, change its role, or (de)activate it.
 *
 * Runs in a transaction because the "is there another owner left" check and the
 * write must not be separated by a concurrent demotion, and takes the account
 * lock first so two simultaneous demotions of two different owners cannot each
 * conclude that the other owner is still there.
 */
export async function updateUser(
  id: string,
  input: UpdateUserInput,
  auth: AuthContext,
): Promise<UserDto> {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id }, select: userSelect });
      if (!existing) throw userNotFound();

      const losesOwnerAccess =
        existing.role === 'OWNER' &&
        existing.active &&
        ((input.role !== undefined && input.role !== 'OWNER') || input.active === false);

      if (losesOwnerAccess) {
        await serialiseAccountChange(tx);
        const otherActiveOwners = await tx.user.count({
          where: { role: 'OWNER', active: true, id: { not: id } },
        });
        if (otherActiveOwners === 0) {
          throw new ConflictError(
            existing.id === auth.userId
              ? 'You are the only active owner. Give another account the owner role before changing your own.'
              : 'This is the only active owner account. Promote another account to owner first.',
            'LAST_OWNER',
          );
        }
      }

      const deactivating = input.active === false && existing.active;

      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          /*
           * Deactivating must end the session the account already holds. There
           * is no server-side session store to delete from, so bumping
           * `tokenValidFrom` is what kills every token issued before now: the
           * next request presenting one is rejected by `requireAuth`.
           */
          ...(deactivating ? { tokenValidFrom: new Date() } : {}),
        },
        select: userSelect,
      });

      const oldData = toUserDto(existing);
      const newData = toUserDto(updated);

      await recordAudit(tx, {
        auth,
        action: auditActionFor(existing, input),
        entityType: 'USER',
        entityId: id,
        summary:
          input.role !== undefined && input.role !== existing.role
            ? `${existing.name} changed from ${existing.role} to ${input.role}`
            : `Account "${existing.name}" updated`,
        oldData,
        newData,
      });

      return newData;
    });
  } catch (error) {
    if (isTransactionConflict(error)) {
      throw new ConflictError(
        'Another change to owner accounts happened at the same time. Please try again.',
        'CONCURRENT_ACCOUNT_CHANGE',
      );
    }
    throw error;
  }
}

/**
 * An owner resets somebody else's password.
 *
 * The new password is returned once so it can be handed over, then forgotten.
 * Every session the account holds is ended, because a reset is the response to a
 * lost or compromised account and leaving live tokens alive would defeat it.
 */
export async function resetUserPassword(
  id: string,
  input: ResetUserPasswordInput,
  auth: AuthContext,
): Promise<InvitedUserDto> {
  const existing = await prisma.user.findUnique({ where: { id }, select: userSelect });
  if (!existing) throw userNotFound();

  if (input.newPassword) {
    const problems = validatePasswordStrength(input.newPassword);
    if (problems.length > 0) {
      throw new ValidationError('That password is not strong enough', { newPassword: problems });
    }
  }

  const temporaryPassword = input.newPassword ?? generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.user.update({
      where: { id },
      data: {
        passwordHash,
        // Whoever set this password is not the person who should keep using it.
        mustChangePassword: true,
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
      // Who reset whose password - never the password itself.
      summary: `${auth.name} reset the password for ${row.name}`,
    });

    return row;
  });

  return { user: toUserDto(updated), temporaryPassword };
}
