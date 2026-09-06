/**
 * Staff & the monthly salary register.
 *
 * The register is a per-month view of people, not a stored table: for the
 * selected month every row carries `salary` (the member's monthly salary),
 * `paid` (the sum of that month's salary payments) and the derived
 * `balance` / `status`. Nothing here is cached in a column, so a payment
 * recorded, edited or reversed is reflected immediately.
 *
 * Query budget for a page of the register is fixed at three statements,
 * whatever the head-count:
 *   1. the filtered staff scope (id, active, salary) - drives the totals
 *   2. the page itself, with its building relation
 *   3. one groupBy over salary payments for that month
 */
import type { z } from 'zod';
import type {
  CreateStaffInput,
  MonthKey,
  PaginationMeta,
  StaffDto,
  StaffLedgerRowDto,
  StaffLedgerTotalsDto,
  UpdateStaffInput,
  staffListQuerySchema,
} from '@hostel/shared';
import { isoDateToUtcDate, utcDateToIsoDate } from '@hostel/shared';
import type { Prisma } from '@prisma/client';
import { prisma, runInTransaction, type PrismaLike } from '../db/prisma';
import {
  balanceOf,
  percent,
  toPaise,
  paiseToRupees,
  rupeesToPaise,
  ZERO,
  type Paise,
} from '../db/money';
import { buildingNotFound, staffNotFound, ValidationError } from '../errors/app-error';
import type { AuthContext } from '../auth/context';
import { recordAudit } from './audit.service';
import { getFeeContext } from './settings.service';
import { salaryStatus, toStaffDto, type StaffWithBuilding } from './mappers';
import {
  countSalaryPaymentsForStaff,
  createStaffRow,
  deleteStaffRow,
  findStaffById,
  findStaffPage,
  findStaffScope,
  salaryPaidByStaff,
  staffOrderBy,
  staffWhere,
  updateStaffRow,
  type SalaryPaidEntry,
} from '../repositories/staff.repository';

export type StaffListQuery = z.infer<typeof staffListQuerySchema>;

/** Pagination plus the payroll stat cards, for the whole filter - not the page. */
export interface StaffLedgerListMeta extends PaginationMeta {
  month: MonthKey;
  totals: StaffLedgerTotalsDto;
}

export interface StaffLedgerListResult {
  rows: StaffLedgerRowDto[];
  meta: StaffLedgerListMeta;
}

/**
 * What one staff member has been paid for the month, in PAISE.
 *
 * `toPaise` rather than a plain read: it copes with a member who has no
 * payments at all and coerces the aggregate the repository hands back to a safe
 * integer, so a corrupt row can never poison the payroll totals.
 */
const paidPaise = (entry: SalaryPaidEntry | undefined): Paise => toPaise(entry?.paid);

const paymentCountOf = (entry: SalaryPaidEntry | undefined): number => entry?.count ?? 0;

const EMPTY_TOTALS: StaffLedgerTotalsDto = {
  activeCount: 0,
  payroll: 0,
  paid: 0,
  pending: 0,
  paidPercent: 0,
};

/* ------------------------------------------------------------------ *
 * Register
 * ------------------------------------------------------------------ */

export async function listStaffLedger(query: StaffListQuery): Promise<StaffLedgerListResult> {
  const { context } = await getFeeContext();
  const month = query.month ?? context.currentMonth;

  const where = staffWhere({
    buildingId: query.buildingId,
    status: query.status,
    search: query.search,
  });

  // The filtered scope doubles as the pagination total, so no extra COUNT.
  const scope = await findStaffScope(where);
  const total = scope.length;

  if (total === 0) {
    return {
      rows: [],
      meta: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 1, month, totals: EMPTY_TOTALS },
    };
  }

  const [page, paidIndex] = await Promise.all([
    findStaffPage(where, {
      orderBy: staffOrderBy(query.sortBy, query.sortOrder),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    salaryPaidByStaff(
      scope.map((row) => row.id),
      month,
    ),
  ]);

  const rows = page.map((staff) => toLedgerRow(staff, month, paidIndex.get(staff.id)));

  // Integer paise throughout: `+` on whole numbers is exact, so the stat cards
  // always reconcile with the rows beneath them.
  let activeCount = 0;
  let payroll: Paise = ZERO;
  let paidTotal: Paise = ZERO;
  let pending: Paise = ZERO;

  for (const member of scope) {
    const paid = paidPaise(paidIndex.get(member.id));
    // Money that actually left the till this month counts whether or not the
    // member is still on duty; only the payroll commitment is active-only.
    paidTotal += paid;
    if (!member.active) continue;
    activeCount += 1;
    const salary = toPaise(member.monthlySalary);
    payroll += salary;
    pending += balanceOf(salary, paid);
  }

  return {
    rows,
    meta: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      month,
      totals: {
        activeCount,
        payroll: paiseToRupees(payroll),
        paid: paiseToRupees(paidTotal),
        pending: paiseToRupees(pending),
        paidPercent: percent(paidTotal, payroll),
      },
    },
  };
}

function toLedgerRow(
  staff: StaffWithBuilding,
  month: MonthKey,
  entry: SalaryPaidEntry | undefined,
): StaffLedgerRowDto {
  const dto = toStaffDto(staff);
  const salary = toPaise(staff.monthlySalary);
  const paid = paidPaise(entry);
  return {
    ...dto,
    month,
    salary: dto.monthlySalary,
    paid: paiseToRupees(paid),
    balance: paiseToRupees(balanceOf(salary, paid)),
    // Decided in paise, not in the rounded rupee numbers that go in the DTO: a
    // salary of 4,500.55 must compare exactly equal to 4,500.55 paid, and only
    // integers guarantee that.
    status: salaryStatus(salary, paid, dto.active),
    paymentCount: paymentCountOf(entry),
  };
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

/** A staff member may be attached to one building or shared across all of them. */
async function assertBuildingExists(
  buildingId: string | null | undefined,
  client: PrismaLike,
): Promise<void> {
  if (!buildingId) return;
  const building = await client.building.findUnique({
    where: { id: buildingId },
    select: { id: true },
  });
  if (!building) throw buildingNotFound();
}

function assertDateOrder(joinDate: string | null, endDate: string | null): void {
  if (joinDate && endDate && endDate < joinDate) {
    throw new ValidationError('Some of the details need fixing', {
      endDate: ['End date cannot be before the joining date'],
    });
  }
}

/** `optionalText`/`uuid` fields arrive as undefined when cleared, so the key decides. */
const provided = (input: UpdateStaffInput, key: keyof UpdateStaffInput): boolean =>
  Object.prototype.hasOwnProperty.call(input, key);

export async function createStaff(input: CreateStaffInput, auth: AuthContext): Promise<StaffDto> {
  const staff = await runInTransaction(async (tx) => {
    await assertBuildingExists(input.buildingId, tx);
    assertDateOrder(input.joinDate ?? null, input.endDate ?? null);

    const created = await createStaffRow(
      {
        name: input.name,
        phone: input.phone ?? null,
        role: input.role ?? null,
        buildingId: input.buildingId ?? null,
        monthlySalary: rupeesToPaise(input.monthlySalary),
        active: input.active,
        joinDate: input.joinDate ? isoDateToUtcDate(input.joinDate) : null,
        endDate: input.endDate ? isoDateToUtcDate(input.endDate) : null,
        notes: input.notes ?? null,
        archivedAt: input.active ? null : new Date(),
      },
      tx,
    );

    await recordAudit(tx, {
      auth,
      action: 'CREATE',
      entityType: 'STAFF',
      entityId: created.id,
      summary: `Added staff member ${created.name}`,
      newData: toStaffDto(created),
    });

    return created;
  });

  return toStaffDto(staff);
}

export async function updateStaff(
  id: string,
  input: UpdateStaffInput,
  auth: AuthContext,
): Promise<StaffDto> {
  const existing = await findStaffById(id);
  if (!existing) throw staffNotFound();
  const before = toStaffDto(existing);

  const updated = await runInTransaction(async (tx) => {
    if (provided(input, 'buildingId')) await assertBuildingExists(input.buildingId, tx);

    const nextJoinDate = provided(input, 'joinDate')
      ? input.joinDate ?? null
      : existing.joinDate
        ? utcDateToIsoDate(existing.joinDate)
        : null;
    const nextEndDate = provided(input, 'endDate')
      ? input.endDate ?? null
      : existing.endDate
        ? utcDateToIsoDate(existing.endDate)
        : null;
    assertDateOrder(nextJoinDate, nextEndDate);

    const data: Prisma.StaffUncheckedUpdateInput = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(provided(input, 'phone') ? { phone: input.phone ?? null } : {}),
      ...(provided(input, 'role') ? { role: input.role ?? null } : {}),
      ...(provided(input, 'buildingId') ? { buildingId: input.buildingId ?? null } : {}),
      ...(input.monthlySalary !== undefined
        ? { monthlySalary: rupeesToPaise(input.monthlySalary) }
        : {}),
      ...(provided(input, 'joinDate')
        ? { joinDate: nextJoinDate ? isoDateToUtcDate(nextJoinDate) : null }
        : {}),
      ...(provided(input, 'endDate')
        ? { endDate: nextEndDate ? isoDateToUtcDate(nextEndDate) : null }
        : {}),
      ...(provided(input, 'notes') ? { notes: input.notes ?? null } : {}),
      // active:false is how the UI marks a member "Left"; it never destroys
      // salary history, so the row is simply stamped as archived.
      ...(input.active !== undefined
        ? {
            active: input.active,
            archivedAt: input.active ? null : existing.archivedAt ?? new Date(),
          }
        : {}),
    };

    const row = await updateStaffRow(id, data, tx);

    await recordAudit(tx, {
      auth,
      action: 'UPDATE',
      entityType: 'STAFF',
      entityId: id,
      summary:
        input.active === false
          ? `Marked staff member ${row.name} as left`
          : `Updated staff member ${row.name}`,
      oldData: before,
      newData: toStaffDto(row),
    });

    return row;
  });

  return toStaffDto(updated);
}

export interface StaffRemovalResultDto {
  id: string;
  name: string;
  /** true when salary history forced a soft delete. */
  archived: boolean;
  deleted: boolean;
  salaryPaymentCount: number;
  message: string;
}

/**
 * Remove a staff member.
 *
 * Salary payments are financial history and are never destroyed: a member who
 * has ever been paid is archived (active:false, archivedAt) and stays on the
 * register as "Left". Only a member with no payments at all is hard-deleted.
 */
export async function removeStaff(id: string, auth: AuthContext): Promise<StaffRemovalResultDto> {
  const existing = await findStaffById(id);
  if (!existing) throw staffNotFound();
  const before = toStaffDto(existing);

  return runInTransaction(async (tx) => {
    const salaryPaymentCount = await countSalaryPaymentsForStaff(id, tx);

    if (salaryPaymentCount > 0) {
      const archived = await updateStaffRow(
        id,
        { active: false, archivedAt: existing.archivedAt ?? new Date() },
        tx,
      );
      await recordAudit(tx, {
        auth,
        action: 'ARCHIVE',
        entityType: 'STAFF',
        entityId: id,
        summary: `Archived staff member ${archived.name} (${salaryPaymentCount} salary payment(s) retained)`,
        oldData: before,
        newData: toStaffDto(archived),
      });
      return {
        id,
        name: archived.name,
        archived: true,
        deleted: false,
        salaryPaymentCount,
        message: `${archived.name} has salary history, so the record was archived rather than deleted. The ${salaryPaymentCount} salary payment(s) are unchanged.`,
      };
    }

    await deleteStaffRow(id, tx);
    await recordAudit(tx, {
      auth,
      action: 'DELETE',
      entityType: 'STAFF',
      entityId: id,
      summary: `Deleted staff member ${existing.name}`,
      oldData: before,
    });
    return {
      id,
      name: existing.name,
      archived: false,
      deleted: true,
      salaryPaymentCount: 0,
      message: `${existing.name} had no salary history and was removed.`,
    };
  });
}

/** Used by the salary service to resolve the member a payment belongs to. */
export function getStaffOrThrow(
  id: string,
  client: PrismaLike = prisma,
): Promise<StaffWithBuilding> {
  return findStaffById(id, client).then((staff) => {
    if (!staff) throw staffNotFound();
    return staff;
  });
}
