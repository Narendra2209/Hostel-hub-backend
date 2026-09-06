/**
 * Structured JSON logging for CloudWatch.
 *
 * Rules enforced here:
 *  - never log identity-document contents, presigned URLs or bearer tokens
 *  - never log database credentials
 *  - a request id ties every line of one request together
 */
import { env } from '../env';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are replaced with [redacted] wherever they appear. */
const REDACT_KEYS = new Set([
  'password',
  'token',
  'accesstoken',
  'idtoken',
  'refreshtoken',
  'authorization',
  'secret',
  'databaseurl',
  'database_url',
  'connectionstring',
  'uploadurl',
  'signedurl',
  'url',
  'photokey',
  'aadhaardocumentkey',
  'aadhaar',
  'objectkey',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level: Level, message: string, context?: Record<string, unknown>): void {
  let threshold: Level = 'info';
  try {
    threshold = env().LOG_LEVEL;
  } catch {
    // Environment not loadable yet (e.g. a boot failure) - log everything.
    threshold = 'debug';
  }
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return;

  const line = JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(context ? (redact(context) as Record<string, unknown>) : {}),
  });

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => write('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => write('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => write('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => write('error', message, context),
};

/** Short correlation id for one request. */
export function requestId(): string {
  return globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
}
