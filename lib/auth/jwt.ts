/**
 * Session tokens.
 *
 * A signed JWT (HS256) carrying nothing but the user id, an issued-at stamp and
 * an expiry. Deliberately NOT the role: roles change, and a token minted an hour
 * ago must not keep OWNER access after an owner demoted the account. Every
 * request loads the User document and reads the role from there, so revocation
 * is immediate.
 *
 * The token's `iat` is checked against the user's `tokenValidFrom`, which is
 * bumped on password change and on an explicit "sign out everywhere". That gives
 * real revocation without a server-side session store - which matters on Lambda,
 * where there is nowhere to keep one.
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../env';
import { UnauthorizedError } from '../errors/app-error';

const ISSUER = 'hostel-manager';
const AUDIENCE = 'hostel-manager-web';

let cachedKey: Uint8Array | null = null;
let cachedSecret: string | null = null;

function signingKey(): Uint8Array {
  const secret = env().JWT_SECRET;
  if (cachedKey && cachedSecret === secret) return cachedKey;
  cachedSecret = secret;
  cachedKey = new TextEncoder().encode(secret);
  return cachedKey;
}

export interface SessionClaims {
  userId: string;
  issuedAt: Date;
  expiresAt: Date;
}

/** Mint a session token for a user id. */
export async function createSessionToken(userId: string): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const ttlHours = env().SESSION_TTL_HOURS;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + ttlHours * 60 * 60 * 1000);

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(signingKey());

  return { token, expiresAt };
}

/** Verify a token's signature, issuer, audience and expiry. */
export async function verifySessionToken(token: string): Promise<SessionClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, signingKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      // A little tolerance for clock drift between the browser and the server.
      clockTolerance: 30,
    }));
  } catch {
    // The specific reason is useful in a log, never in a response.
    throw new UnauthorizedError('Your session has expired. Please sign in again.');
  }

  if (!payload.sub || typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    throw new UnauthorizedError('That session token is not valid.');
  }

  return {
    userId: payload.sub,
    issuedAt: new Date(payload.iat * 1000),
    expiresAt: new Date(payload.exp * 1000),
  };
}

/** Pull the token from the Authorization header, or the session cookie. */
export function extractToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1]!.trim();
  }

  const cookie = request.headers.get('cookie');
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

export const SESSION_COOKIE = 'hostel_session';

/**
 * The Set-Cookie value for a session.
 *
 * HttpOnly so JavaScript (and therefore XSS) cannot read it, SameSite=Lax so it
 * is not sent on cross-site form posts, Secure in production. The SPA also keeps
 * the token in memory and sends it as a Bearer header, which is what makes a
 * cross-origin deployment (CloudFront + API Gateway on different domains) work;
 * the cookie is the belt to that pair of braces.
 */
export function sessionCookie(token: string, expiresAt: Date): string {
  const secure = env().NODE_ENV === 'production' ? '; Secure' : '';
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie(): string {
  const secure = env().NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
