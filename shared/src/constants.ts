/**
 * Application-wide constants shared by the API and the web client.
 * Nothing in here is business *data* - these are configuration defaults and
 * protocol constants. All real business data comes from PostgreSQL.
 */

/** The hostel operates in India; every "today", due date and billing month is evaluated here. */
export const APP_TIMEZONE = 'Asia/Kolkata';

export const DEFAULT_CURRENCY_SYMBOL = '\u20B9'; // rupee sign
export const DEFAULT_CURRENCY_CODE = 'INR';
export const DEFAULT_DUE_DAY = 5;
export const DEFAULT_HOSTEL_NAME = 'Hostel Manager';

/**
 * Seed values for the ExpenseCategory table. These are *configuration*, created
 * idempotently on first read so the application works on a virgin database
 * without ever running the seed script. Categories are stored in PostgreSQL and
 * new ones can be added at runtime.
 */
export const DEFAULT_EXPENSE_CATEGORIES = [
  { slug: 'electricity', name: 'Electricity', sortOrder: 10 },
  { slug: 'water', name: 'Water', sortOrder: 20 },
  { slug: 'gas-lpg', name: 'Gas / LPG', sortOrder: 30 },
  { slug: 'internet', name: 'Internet', sortOrder: 40 },
  { slug: 'mess-groceries', name: 'Mess / groceries', sortOrder: 50 },
  { slug: 'maintenance', name: 'Maintenance', sortOrder: 60 },
  { slug: 'building-rent', name: 'Building rent', sortOrder: 70 },
  { slug: 'other', name: 'Other', sortOrder: 80 },
] as const;

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 200,
} as const;

/** Upload limits enforced on the server before a presigned URL is handed out. */
export const UPLOAD_LIMITS = {
  MAX_IMAGE_BYTES: 8 * 1024 * 1024, // 8 MB
  MAX_DOCUMENT_BYTES: 15 * 1024 * 1024, // 15 MB
  PHOTO_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp'] as const,
  DOCUMENT_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const,
  /** Signed GET URLs for sensitive documents are deliberately short-lived. */
  DOWNLOAD_URL_TTL_SECONDS: 300,
  UPLOAD_URL_TTL_SECONDS: 300,
} as const;

export const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** Sentinel used by the building filter in the UI and query strings. */
export const ALL_BUILDINGS = 'all';
/** Sentinel for expenses / staff that are not attached to a single building. */
export const SHARED_BUILDING = 'shared';
