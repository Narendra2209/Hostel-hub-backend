/**
 * The integration suite: services exercised against a real MongoDB replica set.
 *
 * `vitest.config.ts` deliberately excludes `tests/integration/**` so `npm test`
 * stays hermetic; this config includes only those files. Run it with
 * `npm run test:integration --workspace @hostel/api`.
 *
 * The cluster is shared with the imported historical register, so the suite
 * never drops or truncates a collection. Fixtures are namespaced per run and
 * deleted afterwards (tests/helpers/db.ts), which leaves the register untouched
 * - and because one database is shared by every file, files run one at a time:
 * two suites measuring a dashboard delta at the same moment would see each
 * other's documents.
 *
 * Connection details come from `.env.local`, which is gitignored and holds the
 * Atlas credentials. They are injected into `test.env` below so nothing can
 * construct a Prisma client - or validate `lib/env.ts` - against an
 * unconfigured environment. A variable already present in the real environment
 * always wins, so CI can point the suite at a throwaway cluster.
 */
import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Minimal .env reader: `KEY=value`, optionally quoted, `#` comments ignored. */
function readLocalEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  let contents: string;
  try {
    contents = readFileSync(fileURLToPath(new URL('.env.local', import.meta.url)), 'utf8');
  } catch {
    return values; // Absent file: the environment is expected to be set already.
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key) continue;
    const value = (rawValue ?? '').trim().replace(/^(['"])(.*)\1$/s, '$2');
    // A real environment variable always beats the file.
    const resolved = process.env[key] ?? value;
    if (resolved) values[key] = resolved;
  }
  return values;
}

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/integration/**/*.int.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
    // Set before any module runs, so nothing can construct a Prisma client
    // against an unconfigured environment.
    env: {
      ...readLocalEnv(),
      NODE_ENV: 'test',
    },
    fileParallelism: false,
    sequence: { concurrent: false },
    // Real round trips to Atlas, and a first connection that has to resolve an
    // SRV record and complete a TLS handshake before it can answer anything.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});
