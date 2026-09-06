/**
 * Prisma row -> API DTO.
 *
 * Every route funnels its output through these functions so the shape the web
 * client receives is defined in exactly one place, and so the conversion from
 * Decimal to a JSON number happens at one boundary rather than being scattered.
 */
import type {
  Building,
  Expense,
  ExpenseCategory,
  FeePayment,
  Resident,
  ResidentBuildingHistory,
  SalaryPayment,
  Staff,
} from '@prisma/client';
import type {
  BuildingDto,
  ExpenseDto,
  FeePaymentDto,
  ResidentDto,
  ResidentMoveDto,
  SalaryPaymentDto,
  StaffDto,
} from '@hostel/shared';
import { utcDateToIsoDate, utcDateToMonthKey } from '@hostel/shared';
import { paiseToRupees } from '../db/money';

/* ------------------------------------------------------------------ *
 * Buildings
 * ------------------------------------------------------------------ */

export type BuildingWithCounts = Building & {
  residentCount?: number;
  totalResidentCount?: number;
  staffCount?: number;
  expenseCount?: number;
};

export function toBuildingDto(building: BuildingWithCounts): BuildingDto {
  const totalResidents = building.totalResidentCount ?? 0;
  const staffCount = building.staffCount ?? 0;
  const expenseCount = building.expenseCount ?? 0;
  return {
    id: building.id,
    name: building.name,
    code: building.code,
    address: building.address,
    active: building.active,
    sortOrder: building.sortOrder,
    residentCount: building.residentCount ?? 0,
    totalResidentCount: totalResidents,
    staffCount,
    expenseCount,
    // Deleting a building that still owns records would orphan financial
    // history, so the API refuses and the UI hides the action.
    deletable: totalResidents === 0 && staffCount === 0 && expenseCount === 0,
    createdAt: building.createdAt.toISOString(),
    updatedAt: building.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Residents
 * ------------------------------------------------------------------ */

export type ResidentWithBuilding = Resident & { building?: Pick<Building, 'id' | 'name'> | null };

export function toResidentDto(
  resident: ResidentWithBuilding,
  options: { buildingName?: string; currentMonth?: string } = {},
): ResidentDto {
  const vacatedMonth = resident.vacatedDate ? utcDateToMonthKey(resident.vacatedDate) : null;
  return {
    id: resident.id,
    name: resident.name,
    phone: resident.phone,
    email: resident.email,
    buildingId: resident.buildingId,
    buildingName: options.buildingName ?? resident.building?.name ?? 'Unassigned',
    monthlyFee: paiseToRupees(resident.monthlyFee),
    dueDay: resident.dueDay,
    joinDate: utcDateToIsoDate(resident.joinDate),
    joinMonth: utcDateToMonthKey(resident.joinDate),
    vacatedDate: resident.vacatedDate ? utcDateToIsoDate(resident.vacatedDate) : null,
    vacatedMonth,
    active: resident.active,
    // "Vacated" means their last billed month is already behind us.
    vacated: Boolean(
      vacatedMonth && options.currentMonth && vacatedMonth < options.currentMonth,
    ),
    notes: resident.notes,
    hasPhoto: Boolean(resident.photoFileId),
    hasAadhaarDocument: Boolean(resident.aadhaarFileId),
    createdAt: resident.createdAt.toISOString(),
    updatedAt: resident.updatedAt.toISOString(),
  };
}

export type MoveWithBuildings = ResidentBuildingHistory & {
  fromBuilding?: Pick<Building, 'id' | 'name'> | null;
  toBuilding?: Pick<Building, 'id' | 'name'> | null;
};

export const toResidentMoveDto = (move: MoveWithBuildings): ResidentMoveDto => ({
  id: move.id,
  residentId: move.residentId,
  fromBuildingId: move.fromBuildingId,
  fromBuildingName: move.fromBuilding?.name ?? null,
  toBuildingId: move.toBuildingId,
  toBuildingName: move.toBuilding?.name ?? 'Unknown building',
  effectiveDate: utcDateToIsoDate(move.effectiveDate),
  notes: move.notes,
  createdAt: move.createdAt.toISOString(),
});

/* ------------------------------------------------------------------ *
 * Fee payments
 * ------------------------------------------------------------------ */

export type PaymentWithRelations = FeePayment & {
  resident?: (Pick<Resident, 'id' | 'name' | 'buildingId'> & {
    building?: Pick<Building, 'id' | 'name'> | null;
  }) | null;
  createdBy?: { name: string } | null;
};

export const toFeePaymentDto = (payment: PaymentWithRelations): FeePaymentDto => ({
  id: payment.id,
  residentId: payment.residentId,
  residentName: payment.resident?.name ?? '(removed resident)',
  buildingId: payment.resident?.buildingId ?? null,
  buildingName: payment.resident?.building?.name ?? null,
  billingMonth: utcDateToMonthKey(payment.billingMonth),
  amount: paiseToRupees(payment.amount),
  paymentDate: utcDateToIsoDate(payment.paymentDate),
  paymentMethod: payment.paymentMethod,
  referenceNumber: payment.referenceNumber,
  note: payment.note,
  createdByName: payment.createdBy?.name ?? null,
  createdAt: payment.createdAt.toISOString(),
  updatedAt: payment.updatedAt.toISOString(),
});

/* ------------------------------------------------------------------ *
 * Staff & salaries
 * ------------------------------------------------------------------ */

export type StaffWithBuilding = Staff & { building?: Pick<Building, 'id' | 'name'> | null };

export const toStaffDto = (staff: StaffWithBuilding): StaffDto => ({
  id: staff.id,
  name: staff.name,
  phone: staff.phone,
  role: staff.role,
  buildingId: staff.buildingId,
  buildingName: staff.building?.name ?? null,
  monthlySalary: paiseToRupees(staff.monthlySalary),
  active: staff.active,
  joinDate: staff.joinDate ? utcDateToIsoDate(staff.joinDate) : null,
  endDate: staff.endDate ? utcDateToIsoDate(staff.endDate) : null,
  notes: staff.notes,
  createdAt: staff.createdAt.toISOString(),
  updatedAt: staff.updatedAt.toISOString(),
});

export type SalaryWithRelations = SalaryPayment & {
  staff?: (Pick<Staff, 'id' | 'name' | 'buildingId'> & {
    building?: Pick<Building, 'id' | 'name'> | null;
  }) | null;
  createdBy?: { name: string } | null;
};

export const toSalaryPaymentDto = (payment: SalaryWithRelations): SalaryPaymentDto => ({
  id: payment.id,
  staffId: payment.staffId,
  staffName: payment.staff?.name ?? '(removed staff)',
  buildingId: payment.staff?.buildingId ?? null,
  buildingName: payment.staff?.building?.name ?? null,
  salaryMonth: utcDateToMonthKey(payment.salaryMonth),
  amount: paiseToRupees(payment.amount),
  paymentDate: utcDateToIsoDate(payment.paymentDate),
  paymentMethod: payment.paymentMethod,
  note: payment.note,
  createdByName: payment.createdBy?.name ?? null,
  createdAt: payment.createdAt.toISOString(),
  updatedAt: payment.updatedAt.toISOString(),
});

/** Salary status for one month - the staff equivalent of a fee status. */
export function salaryStatus(
  salary: number,
  paid: number,
  active: boolean,
): 'PAID' | 'PART_PAID' | 'PENDING' | 'INACTIVE' {
  if (!active) return 'INACTIVE';
  if (paid >= salary && salary > 0) return 'PAID';
  if (paid > 0) return 'PART_PAID';
  return 'PENDING';
}

/* ------------------------------------------------------------------ *
 * Expenses
 * ------------------------------------------------------------------ */

export type ExpenseWithRelations = Expense & {
  building?: Pick<Building, 'id' | 'name'> | null;
  category?: Pick<ExpenseCategory, 'id' | 'name'> | null;
  createdBy?: { name: string } | null;
};

export const toExpenseDto = (expense: ExpenseWithRelations): ExpenseDto => ({
  id: expense.id,
  date: utcDateToIsoDate(expense.date),
  buildingId: expense.buildingId,
  buildingName: expense.building?.name ?? null,
  categoryId: expense.categoryId,
  categoryName: expense.category?.name ?? 'Uncategorised',
  amount: paiseToRupees(expense.amount),
  vendor: expense.vendor,
  referenceNumber: expense.referenceNumber,
  note: expense.note,
  createdByName: expense.createdBy?.name ?? null,
  createdAt: expense.createdAt.toISOString(),
  updatedAt: expense.updatedAt.toISOString(),
});

/* ------------------------------------------------------------------ *
 * Prisma `include` fragments, so relation shapes match the mappers above.
 * ------------------------------------------------------------------ */

export const paymentInclude = {
  resident: { select: { id: true, name: true, buildingId: true, building: { select: { id: true, name: true } } } },
  createdBy: { select: { name: true } },
} as const;

export const salaryInclude = {
  staff: { select: { id: true, name: true, buildingId: true, building: { select: { id: true, name: true } } } },
  createdBy: { select: { name: true } },
} as const;

export const expenseInclude = {
  building: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
  createdBy: { select: { name: true } },
} as const;

export const residentInclude = {
  building: { select: { id: true, name: true } },
} as const;
