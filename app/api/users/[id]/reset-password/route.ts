/**
 * POST /api/users/[id]/reset-password
 *
 * An owner gives an account a new password - the "I have forgotten mine" path,
 * since there is no email delivery in this deployment to send a reset link
 * through.
 *
 * The new password is returned once, in this response, and is never stored in
 * plaintext or written to the audit trail. The account is forced to change it
 * on next sign-in and every session it currently holds is ended.
 */
import type { NextRequest } from 'next/server';
import { defineRoute, optionsHandler, parseIdParam } from '@/lib/http/handler';
import { ok } from '@/lib/http/response';
import { resetUserPasswordSchema, type ResetUserPasswordInput } from '@hostel/shared';
import { ValidationError } from '@/lib/errors/app-error';
import { resetUserPassword } from '@/lib/services/user.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OPTIONS = optionsHandler;

/**
 * Every field of `resetUserPasswordSchema` is optional: sending nothing at all
 * means "generate one for me", which is the common case. `parseBody` would
 * reject an empty body as invalid JSON, so the body is read directly and an
 * empty one is treated as `{}`.
 */
async function parseOptionalBody(request: NextRequest): Promise<ResetUserPasswordInput> {
  const raw = (await request.text()).trim();

  let body: unknown = {};
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ValidationError('The request body was not valid JSON');
    }
  }

  const result = resetUserPasswordSchema.safeParse(body);
  if (!result.success) {
    const details: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.length > 0 ? issue.path.join('.') : '_';
      (details[key] ??= []).push(issue.message);
    }
    throw new ValidationError('Some of the details need fixing', details);
  }

  return result.data;
}

export const POST = defineRoute<{ id: string }>(
  // Weighted: this hashes a password.
  { role: 'OWNER', rateLimitWeight: 5 },
  async ({ request, params, auth, origin }) => {
    const id = parseIdParam(params);
    const input = await parseOptionalBody(request);
    return ok(await resetUserPassword(id, input, auth), { origin });
  },
);
