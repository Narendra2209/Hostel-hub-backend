import { z } from 'zod';
import { USER_ROLES } from '../types.js';

/**
 * Authentication schemas, shared by the login form and the API that validates
 * it again. Client-side validation is a courtesy; the server never trusts it.
 */

export const emailField = z
  .string()
  .trim()
  .min(1, 'Enter your email address')
  .max(254)
  .email('Enter a valid email address')
  .transform((value) => value.toLowerCase());

/**
 * The password policy, mirrored from apps/api/lib/auth/password.ts so the form
 * can show the rules before a round trip. The server is still the authority.
 */
export const strongPasswordField = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200, 'Use at most 200 characters')
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/[0-9]/, 'Include a digit');

export const loginSchema = z.object({
  email: emailField,
  // Deliberately not strength-checked: an existing password must be accepted
  // as typed, whatever policy was in force when it was set.
  password: z.string().min(1, 'Enter your password'),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: strongPasswordField,
    confirmPassword: z.string().min(1, 'Confirm your new password'),
  })
  .superRefine((value, ctx) => {
    if (value.newPassword !== value.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmPassword'],
        message: 'Those passwords do not match',
      });
    }
    if (value.newPassword === value.currentPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newPassword'],
        message: 'Choose a password you have not used before',
      });
    }
  });

/** Creating the very first OWNER on a fresh database. */
export const bootstrapSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(150),
  email: emailField,
  password: strongPasswordField,
  hostelName: z.string().trim().min(1).max(120).optional(),
});

/** An owner inviting a colleague. The server generates the temporary password. */
export const inviteUserSchema = z.object({
  name: z.string().trim().min(2, 'Enter a name').max(150),
  email: emailField,
  role: z.enum(USER_ROLES).default('VIEWER'),
});

/** An owner resetting somebody else's password. */
export const resetUserPasswordSchema = z.object({
  /** Omit to have the server generate a temporary one. */
  newPassword: strongPasswordField.optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type BootstrapInput = z.infer<typeof bootstrapSchema>;
export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type ResetUserPasswordInput = z.infer<typeof resetUserPasswordSchema>;
