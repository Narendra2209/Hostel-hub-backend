/**
 * The shared API contract.
 *
 * Every type in this file describes data that originates in MongoDB and is
 * served by the Next.js API. The web client renders these values; it never
 * recomputes the financial ones. Where the backend has already worked out
 * `expected`, `paid`, `balance`, `status`, `dueDate` or `daysOverdue`, those are
 * the authoritative numbers.
 */
import type { IsoDate, MonthKey } from './date.js';

/* ------------------------------------------------------------------ *
 * Enumerations
 * ------------------------------------------------------------------ */

/** Ordered most- to least-privileged, which is the order the UI lists them in. */
export const USER_ROLES = ['OWNER', 'ADMIN', 'DEVELOPER', 'MANAGER', 'VIEWER'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Ascending privilege for *write* access. A role satisfies a requirement when
 * its rank is >= the required rank.
 *
 * DEVELOPER deliberately shares ADMIN's rank rather than sitting above it. It
 * is a support role: it can create and update every business record, which is
 * what makes it useful for reproducing a problem, but it must not be able to
 * change hostel settings or hand itself a higher role - a role that can promote
 * itself is not a role, it is a back door. What DEVELOPER has *in addition* to
 * ADMIN is visibility (the activity log and system diagnostics), expressed as
 * capabilities below rather than as rank.
 */
export const ROLE_RANK: Record<UserRole, number> = {
  VIEWER: 0,
  MANAGER: 1,
  ADMIN: 2,
  DEVELOPER: 2,
  OWNER: 3,
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  OWNER: 'Everything, including settings and staff accounts',
  ADMIN: 'Residents, staff, buildings and corrections',
  DEVELOPER: 'Full create and update access, plus the activity log and diagnostics',
  MANAGER: 'Record payments, salaries and bills',
  VIEWER: 'Read-only',
};

/** Who may read the activity log - the record of who changed what. */
export const canViewActivityLog = (role: UserRole): boolean =>
  role === 'OWNER' || role === 'ADMIN' || role === 'DEVELOPER';

/** Who may read system diagnostics (database health, pool state, timings). */
export const canViewDiagnostics = (role: UserRole): boolean =>
  role === 'OWNER' || role === 'DEVELOPER';

/**
 * Who works the support queue: sees every ticket, assigns, changes status and
 * writes internal notes. Everyone else can still RAISE a ticket and follow
 * their own - that needs no capability at all, only a signed-in session.
 */
export const canManageTickets = (role: UserRole): boolean =>
  role === 'OWNER' || role === 'DEVELOPER';

export const hasRoleAtLeast = (role: UserRole, required: UserRole): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[required];

export const PAYMENT_STATUSES = [
  'PAID',
  'PART_PAID',
  'OVERDUE',
  'NOT_DUE',
  'NOT_STAYING',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = [
  'CASH',
  'UPI',
  'BANK_TRANSFER',
  'CARD',
  'CHEQUE',
  'OTHER',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  BANK_TRANSFER: 'Bank transfer',
  CARD: 'Card',
  CHEQUE: 'Cheque',
  OTHER: 'Other',
};

export const STATUS_LABELS: Record<PaymentStatus, string> = {
  PAID: 'Paid',
  PART_PAID: 'Part paid',
  OVERDUE: 'Overdue',
  NOT_DUE: 'Not due yet',
  NOT_STAYING: 'Not staying',
};

export type ResidentStatusFilter = 'all' | 'staying' | 'vacated' | 'archived';

export const AUDIT_ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'ARCHIVE',
  'RESTORE',
  'MOVE',
  'LOGIN',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditEntityType =
  | 'RESIDENT'
  | 'BUILDING'
  | 'FEE_PAYMENT'
  | 'STAFF'
  | 'SALARY_PAYMENT'
  | 'EXPENSE'
  | 'EXPENSE_CATEGORY'
  | 'SETTINGS'
  | 'USER'
  | 'SESSION';

export type DocumentKind = 'photo' | 'aadhaar';

/* ------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------ */

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiSuccess<TData, TMeta = undefined> {
  success: true;
  data: TData;
  meta?: TMeta;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  /** Field-level messages produced by Zod. Never contains stack traces. */
  details?: Record<string, string[]>;
}

export interface ApiFailure {
  success: false;
  error: ApiErrorBody;
}

export type ApiResponse<TData, TMeta = undefined> = ApiSuccess<TData, TMeta> | ApiFailure;

export type PaginatedResponse<TItem> = ApiSuccess<TItem[], PaginationMeta>;

export interface ListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

export interface CurrentUserDto {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  /** Set for invited accounts; the UI forces a password change before continuing. */
  mustChangePassword: boolean;
  /** Convenience flags so the UI does not re-derive permissions from the role. */
  permissions: {
    canRead: boolean;
    canRecordTransactions: boolean;
    canManageRecords: boolean;
    canAdminister: boolean;
    /** See the record of who changed what. */
    canViewActivityLog: boolean;
    /** See database health, connection pool state and request timings. */
    canViewDiagnostics: boolean;
  };
}

/** A user as listed in Settings. Never carries the password hash. */
export interface UserDto {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface LoginResponseDto {
  user: CurrentUserDto;
  token: string;
  expiresAt: string;
}

/** Whether the very first owner account still needs creating. */
export interface AuthStatusDto {
  needsBootstrap: boolean;
  hostelName: string;
}

/** Returned when an owner invites someone; the temporary password is shown once. */
export interface InvitedUserDto {
  user: UserDto;
  temporaryPassword: string;
}

/* ------------------------------------------------------------------ *
 * Settings & buildings
 * ------------------------------------------------------------------ */

export interface SettingsDto {
  id: string;
  hostelName: string;
  currency: string;
  currencyCode: string;
  defaultDueDay: number;
  timezone: string;
  updatedAt: string;
}

export interface BuildingDto {
  id: string;
  name: string;
  code: string | null;
  address: string | null;
  active: boolean;
  sortOrder: number;
  /** Residents currently staying (not vacated, not archived). */
  residentCount: number;
  /** Every resident ever attached, archived ones included - governs deletability. */
  totalResidentCount: number;
  staffCount: number;
  expenseCount: number;
  /** False when the building still has dependent records. */
  deletable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseCategoryDto {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  sortOrder: number;
  expenseCount: number;
}

/* ------------------------------------------------------------------ *
 * Residents
 * ------------------------------------------------------------------ */

export interface ResidentDto {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  buildingId: string;
  buildingName: string;
  monthlyFee: number;
  dueDay: number;
  joinDate: IsoDate;
  joinMonth: MonthKey;
  vacatedDate: IsoDate | null;
  vacatedMonth: MonthKey | null;
  /** false => archived (soft deleted). Financial history is always retained. */
  active: boolean;
  /** Derived: has a vacated date that is in the past. */
  vacated: boolean;
  notes: string | null;
  hasPhoto: boolean;
  hasAadhaarDocument: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A resident row enriched with the selected month's fee position. */
export interface ResidentListRowDto extends ResidentDto {
  currentMonth: MonthFeeStatusDto;
  overdue: OverdueSummaryDto;
}

export interface ResidentListMeta extends PaginationMeta {
  month: MonthKey;
  stayingCount: number;
  totalOnRecord: number;
}

export interface MonthFeeStatusDto {
  month: MonthKey;
  expected: number;
  paid: number;
  balance: number;
  status: PaymentStatus;
  dueDate: IsoDate | null;
  daysOverdue: number;
  paymentCount: number;
}

export interface OverdueSummaryDto {
  totalOverdue: number;
  oldestUnpaidMonth: MonthKey | null;
  numberOfOverdueMonths: number;
  maxDaysOverdue: number;
}

export interface ResidentMoveDto {
  id: string;
  residentId: string;
  fromBuildingId: string | null;
  fromBuildingName: string | null;
  toBuildingId: string;
  toBuildingName: string;
  effectiveDate: IsoDate;
  notes: string | null;
  createdAt: string;
}

export interface ResidentProfileDto {
  resident: ResidentDto;
  totals: {
    totalPaid: number;
    paymentCount: number;
    currentMonth: MonthFeeStatusDto;
    overdue: OverdueSummaryDto;
    /** Balance across every billing month so far, due or not. */
    outstandingAllMonths: number;
  };
  monthlyHistory: MonthFeeStatusDto[];
  payments: FeePaymentDto[];
  moves: ResidentMoveDto[];
}

/* ------------------------------------------------------------------ *
 * Fee payments & ledger
 * ------------------------------------------------------------------ */

export interface FeePaymentDto {
  id: string;
  residentId: string;
  residentName: string;
  buildingId: string | null;
  buildingName: string | null;
  billingMonth: MonthKey;
  amount: number;
  paymentDate: IsoDate;
  paymentMethod: PaymentMethod;
  referenceNumber: string | null;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeeLedgerRowDto {
  residentId: string;
  residentName: string;
  phone: string | null;
  buildingId: string;
  buildingName: string;
  monthlyFee: number;
  dueDay: number;
  dueDate: IsoDate;
  expected: number;
  paid: number;
  balance: number;
  status: PaymentStatus;
  daysOverdue: number;
  paymentCount: number;
}

export interface FeeLedgerTotalsDto {
  residentCount: number;
  expected: number;
  paid: number;
  balance: number;
  collectionRate: number;
}

export interface FeeLedgerResponseDto {
  month: MonthKey;
  rows: FeeLedgerRowDto[];
  totals: FeeLedgerTotalsDto;
}

/** One resident's Jan-Dec strip. */
export interface FeeStatusStripDto {
  residentId: string;
  year: number;
  months: { month: MonthKey; status: PaymentStatus; balance: number }[];
}

/* ------------------------------------------------------------------ *
 * Overdue
 * ------------------------------------------------------------------ */

/** One overdue billing month for one resident - the reference UI's row shape. */
export interface OverdueRowDto {
  residentId: string;
  residentName: string;
  phone: string | null;
  buildingId: string;
  buildingName: string;
  month: MonthKey;
  expected: number;
  paid: number;
  balance: number;
  dueDate: IsoDate;
  daysOverdue: number;
}

export interface OverdueTotalsDto {
  totalOverdue: number;
  overdueMonthCount: number;
  residentCount: number;
  stayingResidentCount: number;
  oldestDaysOverdue: number;
  oldestResidentName: string | null;
}

export interface OverdueResponseMeta extends PaginationMeta {
  totals: OverdueTotalsDto;
}

/** Grouped-by-resident view, used by the dashboard "who owes money" card. */
export interface OverdueResidentDto {
  residentId: string;
  residentName: string;
  phone: string | null;
  buildingId: string;
  buildingName: string;
  totalOverdue: number;
  oldestUnpaidMonth: MonthKey | null;
  numberOfOverdueMonths: number;
  maxDaysOverdue: number;
}

/* ------------------------------------------------------------------ *
 * Staff & salaries
 * ------------------------------------------------------------------ */

export interface StaffDto {
  id: string;
  name: string;
  phone: string | null;
  role: string | null;
  /** null means the member is shared across every building. */
  buildingId: string | null;
  buildingName: string | null;
  monthlySalary: number;
  active: boolean;
  joinDate: IsoDate | null;
  endDate: IsoDate | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaffLedgerRowDto extends StaffDto {
  month: MonthKey;
  salary: number;
  paid: number;
  balance: number;
  status: 'PAID' | 'PART_PAID' | 'PENDING' | 'INACTIVE';
  paymentCount: number;
}

export interface StaffLedgerTotalsDto {
  activeCount: number;
  payroll: number;
  paid: number;
  pending: number;
  paidPercent: number;
}

export interface StaffLedgerResponseDto {
  month: MonthKey;
  rows: StaffLedgerRowDto[];
  totals: StaffLedgerTotalsDto;
}

export interface SalaryPaymentDto {
  id: string;
  staffId: string;
  staffName: string;
  buildingId: string | null;
  buildingName: string | null;
  salaryMonth: MonthKey;
  amount: number;
  paymentDate: IsoDate;
  paymentMethod: PaymentMethod;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Expenses
 * ------------------------------------------------------------------ */

export interface ExpenseDto {
  id: string;
  date: IsoDate;
  /** null means a shared cost that has not been attributed to one building. */
  buildingId: string | null;
  buildingName: string | null;
  categoryId: string;
  categoryName: string;
  amount: number;
  vendor: string | null;
  referenceNumber: string | null;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseTotalsDto {
  total: number;
  count: number;
  byCategory: { categoryId: string; categoryName: string; amount: number }[];
  byBuilding: { buildingId: string | null; buildingName: string; amount: number }[];
}

export interface ExpenseListMeta extends PaginationMeta {
  totals: ExpenseTotalsDto;
}

/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */

export interface BuildingSummaryDto {
  buildingId: string | null;
  buildingName: string;
  /** true for the synthetic "Shared, not assigned" row. */
  shared: boolean;
  residentCount: number;
  billed: number;
  collected: number;
  overdue: number;
  bills: number;
  salaries: number;
  net: number;
}

export interface ExpenseBreakdownItemDto {
  categoryId: string;
  categoryName: string;
  amount: number;
  share: number;
}

export interface SalarySummaryItemDto {
  staffId: string;
  name: string;
  role: string | null;
  buildingId: string | null;
  buildingName: string | null;
  salary: number;
  paid: number;
  balance: number;
  status: 'PAID' | 'PART_PAID' | 'PENDING' | 'INACTIVE';
}

export interface DashboardDto {
  month: MonthKey;
  buildingId: string | null;
  buildingName: string;
  buildingCount: number;
  residentCount: number;
  expectedFees: number;
  collectedFees: number;
  outstandingThisMonth: number;
  overdueAllMonths: number;
  overdueResidentCount: number;
  salaryPaid: number;
  expenses: number;
  totalSpent: number;
  net: number;
  buildingSummary: BuildingSummaryDto[];
  buildingSummaryTotals: Omit<BuildingSummaryDto, 'buildingId' | 'buildingName' | 'shared'>;
  overdueResidents: OverdueResidentDto[];
  overdueResidentTotal: number;
  expenseBreakdown: ExpenseBreakdownItemDto[];
  salarySummary: SalarySummaryItemDto[];
  feeStrips: FeeStatusStripDto[];
  feeStripResidents: { residentId: string; name: string; buildingName: string; monthlyFee: number }[];
  feeStripYear: number;
  feeStripTruncated: boolean;
}

/* ------------------------------------------------------------------ *
 * Profit & loss
 * ------------------------------------------------------------------ */

export interface PnlColumnDto {
  buildingId: string | null;
  buildingName: string;
  shared: boolean;
  billed: number;
  collected: number;
  arrears: number;
  categories: { categoryId: string; categoryName: string; amount: number }[];
  billsTotal: number;
  salaries: number;
  expenses: number;
  /** Cash basis: collected - expenses. */
  net: number;
  /** Accrual memo: billed - expenses. */
  accrual: number;
}

export interface PnlMonthRowDto {
  month: MonthKey;
  collected: number;
  expenses: number;
  net: number;
}

export interface PnlResponseDto {
  month: MonthKey;
  basis: 'CASH';
  columns: PnlColumnDto[];
  total: PnlColumnDto;
  categoryNames: { categoryId: string; categoryName: string }[];
  year: number;
  yearToDate: PnlMonthRowDto[];
  yearTotals: { collected: number; expenses: number; net: number };
  peak: number;
}

/* ------------------------------------------------------------------ *
 * Uploads
 * ------------------------------------------------------------------ */

export interface PresignedUploadDto {
  uploadUrl: string;
  objectKey: string;
  /** Headers the browser must echo back on the PUT for the signature to match. */
  requiredHeaders: Record<string, string>;
  expiresInSeconds: number;
}

export interface SignedDocumentDto {
  url: string;
  objectKey: string;
  contentType: string | null;
  expiresInSeconds: number;
}

/* ------------------------------------------------------------------ *
 * Support tickets
 *
 * Anyone signed in can raise one from any screen. Reporters see only their own;
 * OWNER and DEVELOPER see the whole queue.
 * ------------------------------------------------------------------ */

export const TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_ON_REPORTER',
  'RESOLVED',
  'CLOSED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  WAITING_ON_REPORTER: 'Waiting on you',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

/** Statuses that still need somebody to do something. */
export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_ON_REPORTER',
];

export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  LOW: 'Low',
  NORMAL: 'Normal',
  HIGH: 'High',
  URGENT: 'Urgent',
};

export const TICKET_CATEGORIES = [
  'BUG',
  'DATA_ISSUE',
  'ACCESS',
  'QUESTION',
  'FEATURE_REQUEST',
  'OTHER',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = {
  BUG: 'Something is broken',
  DATA_ISSUE: 'A figure looks wrong',
  ACCESS: 'Access or permissions',
  QUESTION: 'A question',
  FEATURE_REQUEST: 'A suggestion',
  OTHER: 'Something else',
};

export interface TicketPersonDto {
  id: string | null;
  name: string;
  role: UserRole | null;
}

export interface TicketCommentDto {
  id: string;
  body: string;
  /** Only ever true on comments returned to someone who manages tickets. */
  internal: boolean;
  /** Written by the system (status changed, reassigned) rather than a person. */
  systemNote: boolean;
  author: TicketPersonDto;
  createdAt: string;
}

export interface TicketDto {
  id: string;
  reference: string;
  title: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  raisedBy: TicketPersonDto;
  assignedTo: TicketPersonDto | null;
  /** Captured automatically when the ticket is raised. */
  pageUrl: string | null;
  commentCount: number;
  lastActivityAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** What the caller may do with THIS ticket, decided by the server. */
  permissions: {
    canComment: boolean;
    canChangeStatus: boolean;
    canAssign: boolean;
    canSeeInternalNotes: boolean;
  };
}

/** A ticket with its full thread, for the detail view. */
export interface TicketDetailDto extends TicketDto {
  comments: TicketCommentDto[];
  /** Only populated for people who can assign; empty otherwise. */
  assignableTo: TicketPersonDto[];
}

export interface TicketCountsDto {
  open: number;
  inProgress: number;
  waitingOnReporter: number;
  resolved: number;
  closed: number;
  /** OPEN + IN_PROGRESS + WAITING_ON_REPORTER - what the sidebar badge shows. */
  unresolved: number;
}

export interface TicketListMeta extends PaginationMeta {
  counts: TicketCountsDto;
  /** True when the caller is seeing the whole queue rather than just their own. */
  viewingAll: boolean;
}

/* ------------------------------------------------------------------ *
 * Activity log - "who changed what"
 *
 * The audit trail rendered for people rather than for machines: the raw
 * before/after JSON is reduced to the fields that actually differ, and the actor
 * and the affected record are resolved to names.
 * ------------------------------------------------------------------ */

export interface ActivityChangeDto {
  field: string;
  /** Rendered values, already formatted. null means the field was unset. */
  before: string | null;
  after: string | null;
}

export interface ActivityEntryDto {
  id: string;
  at: string;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  /** Human label for the affected record, e.g. the resident's name. */
  entityLabel: string | null;
  summary: string | null;
  actor: {
    id: string | null;
    name: string;
    role: UserRole | null;
  };
  /** Empty for CREATE and DELETE, where the whole record is the change. */
  changes: ActivityChangeDto[];
}

/** Options for the filter controls, derived from what is actually in the log. */
export interface ActivityFiltersDto {
  entityTypes: AuditEntityType[];
  actors: { id: string; name: string }[];
}

export interface ActivityListMeta extends PaginationMeta {
  filters: ActivityFiltersDto;
}

/* ------------------------------------------------------------------ *
 * Diagnostics - for the DEVELOPER role
 * ------------------------------------------------------------------ */

export interface DiagnosticsDto {
  database: {
    connected: boolean;
    name: string;
    collections: { name: string; documents: number; indexes: number; sizeBytes: number }[];
    totalDocuments: number;
    storageBytes: number;
  };
  runtime: {
    nodeVersion: string;
    environment: string;
    /** How long this server process (or warm Lambda container) has been up. */
    uptimeSeconds: number;
    memoryMb: { rss: number; heapUsed: number; heapTotal: number };
  };
  /** In-process caches: how well they are working. */
  caches: {
    name: string;
    entries: number;
    hits: number;
    misses: number;
    hitRate: number;
  }[];
  /** Slowest routes observed by this container since it started. */
  timings: {
    route: string;
    count: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
  }[];
  generatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Audit log
 * ------------------------------------------------------------------ */

export interface AuditLogDto {
  id: string;
  userId: string | null;
  userName: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  summary: string | null;
  oldData: unknown;
  newData: unknown;
  createdAt: string;
}
