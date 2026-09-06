import { z } from 'zod';
import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from '../types.js';
import { idSchema, optionalText, paginationQuerySchema } from './common.js';

/**
 * Support ticket schemas.
 *
 * Raising a ticket is deliberately the lightest form in the application: a
 * title and a description are all that is required. Everything else - the page
 * the reporter was on, who they are, when it happened - the server captures for
 * them, because a support form that demands work is a support form nobody uses.
 */

export const createTicketSchema = z.object({
  title: z
    .string()
    .trim()
    .min(5, 'Give the problem a short title')
    .max(150, 'Keep the title under 150 characters'),
  description: z
    .string()
    .trim()
    .min(10, 'Describe what happened, in a sentence or two')
    .max(5000, 'Keep the description under 5000 characters'),
  category: z.enum(TICKET_CATEGORIES).default('QUESTION'),
  /**
   * Reporters may flag something as urgent; whoever works the queue can revise
   * it. Trusting the reporter here is the right default - the alternative is a
   * form that argues with someone who is already having a bad day.
   */
  priority: z.enum(TICKET_PRIORITIES).default('NORMAL'),
  /** Sent by the client so the ticket records which screen it came from. */
  pageUrl: optionalText(500),
});

/**
 * Updating a ticket. Every field is restricted to people who manage the queue,
 * which the route enforces - the schema only says what is well-formed.
 */
export const updateTicketSchema = z
  .object({
    status: z.enum(TICKET_STATUSES),
    priority: z.enum(TICKET_PRIORITIES),
    category: z.enum(TICKET_CATEGORIES),
    /** null unassigns. */
    assignedToId: idSchema.nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const addTicketCommentSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Write a reply first')
    .max(5000, 'Keep the reply under 5000 characters'),
  /**
   * An internal note is never shown to the reporter. The route refuses this for
   * anyone who cannot manage tickets, so a reporter cannot mark their own
   * message internal and hide it from the person helping them.
   */
  internal: z.boolean().default(false),
});

export const ticketListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['all', 'unresolved', ...TICKET_STATUSES]).default('unresolved'),
  priority: z.enum(['all', ...TICKET_PRIORITIES]).default('all'),
  category: z.enum(['all', ...TICKET_CATEGORIES]).default('all'),
  /** Ignored for reporters, who always see only their own. */
  raisedById: idSchema.optional(),
  assignedToId: z.union([idSchema, z.literal('unassigned'), z.literal('me')]).optional(),
  /** "mine" restricts an otherwise queue-wide view to the caller's own tickets. */
  scope: z.enum(['all', 'mine']).default('all'),
  sortBy: z.enum(['lastActivityAt', 'createdAt', 'priority', 'status']).default('lastActivityAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type AddTicketCommentInput = z.infer<typeof addTicketCommentSchema>;
