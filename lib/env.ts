/**
 * Environment configuration, validated once at module load.
 *
 * Nothing here is ever sent to the browser. The web client receives only the
 * `VITE_*` public values defined in apps/web/.env.
 */
import { z } from 'zod';

const booleanish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => v === true || v === 'true' || v === '1');

/** The dev-only placeholder shipped in .env.example; refused in production. */
const INSECURE_DEV_SECRET_MARKER = 'dev-only-secret';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** MongoDB connection string, including the database name and credentials. */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((url) => url.startsWith('mongodb://') || url.startsWith('mongodb+srv://'), {
      message: 'DATABASE_URL must be a mongodb:// or mongodb+srv:// connection string',
    }),

  /**
   * Signing key for session tokens. Rotating it invalidates every session,
   * which is the emergency "sign everybody out" lever.
   */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),

  /** Comma-separated list of origins allowed to call this API. */
  FRONTEND_URL: z.string().default('http://localhost:5173'),

  /** Largest document accepted by the upload endpoints, in megabytes. */
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(50).default(15),

  /** Simple in-process rate limit; the production edge limit lives in API Gateway/WAF. */
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(300),
  /** Failed sign-ins before an account is locked, and for how long. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(8),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /** Only used by the deployment tooling; harmless when absent. */
  AWS_REGION: z.string().optional(),
  ALLOW_PRODUCTION_SCRIPTS: booleanish,
});

type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const value = parsed.data;

  if (value.NODE_ENV === 'production') {
    // A production deployment running on the example secret would let anyone
    // who has read the repository mint a valid OWNER session. Refuse to boot.
    if (value.JWT_SECRET.includes(INSECURE_DEV_SECRET_MARKER)) {
      throw new Error(
        'JWT_SECRET is still the development placeholder. Generate a real one before deploying.',
      );
    }
    if (value.JWT_SECRET.length < 48) {
      throw new Error('JWT_SECRET must be at least 48 characters in production.');
    }
  }

  return value;
}

let cached: Env | null = null;

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Only for tests, which mutate process.env between cases. */
export function resetEnvCache(): void {
  cached = null;
}

export const isProduction = (): boolean => env().NODE_ENV === 'production';
export const isTest = (): boolean => env().NODE_ENV === 'test';

/** Origins permitted by CORS, derived from FRONTEND_URL (comma separated). */
export function allowedOrigins(): string[] {
  return env()
    .FRONTEND_URL.split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export const maxUploadBytes = (): number => env().MAX_UPLOAD_MB * 1024 * 1024;
