/**
 * Resolving the caller into an application User.
 *
 * The token proves *who* you are and nothing else. The role that governs
 * authorization is read from the User document on every request, so demoting or
 * deactivating an account takes effect immediately rather than when their token
 * happens to expire.
 */
import type { CurrentUserDto, UserRole } from '@hostel/shared';
import {
  canViewActivityLog as roleCanViewActivityLog,
  canViewDiagnostics as roleCanViewDiagnostics,
  hasRoleAtLeast,
} from '@hostel/shared';
import { prisma } from '../db/prisma';
import { ForbiddenError, UnauthorizedError } from '../errors/app-error';
import { extractToken, verifySessionToken } from './jwt';

export interface AuthContext {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  mustChangePassword: boolean;
}

function toContext(user: {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  mustChangePassword: boolean;
}): AuthContext {
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active,
    mustChangePassword: user.mustChangePassword,
  };
}

/** Authenticate a request, or throw. */
export async function requireAuth(request: Request): Promise<AuthContext> {
  const token = extractToken(request);
  if (!token) throw new UnauthorizedError('Please sign in to continue');

  const claims = await verifySessionToken(token);

  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      mustChangePassword: true,
      tokenValidFrom: true,
    },
  });

  // The account was deleted after the token was issued.
  if (!user) throw new UnauthorizedError('Your session is no longer valid. Please sign in again.');

  /*
   * Revocation. `tokenValidFrom` is bumped whenever the password changes or an
   * owner forces a sign-out, so every token minted before that instant is dead.
   * The one-second slack absorbs the fact that `iat` is stored with second
   * precision while `tokenValidFrom` is a millisecond timestamp - without it, a
   * token minted in the same second as the change would be rejected and the
   * user would be bounced straight back to the login screen after setting a new
   * password.
   */
  if (claims.issuedAt.getTime() + 1000 < user.tokenValidFrom.getTime()) {
    throw new UnauthorizedError('Your session has ended. Please sign in again.');
  }

  if (!user.active) {
    throw new ForbiddenError('This account has been deactivated. Ask an owner to re-enable it.');
  }

  return toContext(user);
}

/** Assert a minimum role, or throw ForbiddenError. */
export function requireRole(context: AuthContext, required: UserRole): AuthContext {
  if (!hasRoleAtLeast(context.role, required)) {
    throw new ForbiddenError(
      `This action needs ${required} access; your account is ${context.role}.`,
    );
  }
  return context;
}

export const canRead = (role: UserRole): boolean => hasRoleAtLeast(role, 'VIEWER');
/** Record payments, salaries and expenses - day-to-day operations. */
export const canRecordTransactions = (role: UserRole): boolean => hasRoleAtLeast(role, 'MANAGER');
/** Create/edit residents, staff, buildings; delete transactions. */
export const canManageRecords = (role: UserRole): boolean => hasRoleAtLeast(role, 'ADMIN');
/** Settings, user roles, destructive operations. */
export const canAdminister = (role: UserRole): boolean => hasRoleAtLeast(role, 'OWNER');

/**
 * See the activity log - who changed what, and what the value was before.
 * Granted by capability rather than rank, because DEVELOPER shares ADMIN's write
 * rank but is the role that exists specifically to answer "who changed this?".
 */
export const canViewActivityLog = (role: UserRole): boolean => roleCanViewActivityLog(role);

/** See database health, connection-pool state and request timings. */
export const canViewDiagnostics = (role: UserRole): boolean => roleCanViewDiagnostics(role);

/**
 * Guard for a capability that is not expressible as a minimum rank.
 * Throws ForbiddenError, exactly as requireRole does.
 */
export function requireCapability(
  context: AuthContext,
  capability: 'activityLog' | 'diagnostics',
): AuthContext {
  const allowed =
    capability === 'activityLog'
      ? canViewActivityLog(context.role)
      : canViewDiagnostics(context.role);
  if (!allowed) {
    const needed = capability === 'activityLog' ? 'the activity log' : 'system diagnostics';
    throw new ForbiddenError(`Your account (${context.role}) cannot view ${needed}.`);
  }
  return context;
}

export function toCurrentUserDto(context: AuthContext): CurrentUserDto {
  return {
    id: context.userId,
    name: context.name,
    email: context.email,
    role: context.role,
    active: context.active,
    mustChangePassword: context.mustChangePassword,
    permissions: {
      canRead: canRead(context.role),
      canRecordTransactions: canRecordTransactions(context.role),
      canManageRecords: canManageRecords(context.role),
      canAdminister: canAdminister(context.role),
      canViewActivityLog: canViewActivityLog(context.role),
      canViewDiagnostics: canViewDiagnostics(context.role),
    },
  };
}

/** Has anybody signed up yet? Drives the first-run owner bootstrap. */
export async function hasAnyUser(): Promise<boolean> {
  return (await prisma.user.count()) > 0;
}
