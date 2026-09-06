/**
 * The money path, end to end, against a real MongoDB replica set.
 *
 * Every test here builds its own building and residents, then calls the same
 * services the route handlers call - `getFeeLedger`, `createPayment`,
 * `settlePayment`, `updatePayment`, `deletePayment` - and asserts what the
 * database and the ledger say afterwards. Nothing is stubbed: the fee engine,
 * the integer-paise arithmetic, the transactions and the audit trail are all
 * the production ones.
 *
 * Two units are in play and the difference is deliberate. Anything read back
 * out of a document - `feePayment.amount` - is PAISE, because that is what the
 * column holds. Anything read off a DTO is rupees, because that is what crosses
 * the API boundary. Fixture inputs are rupees, like a request body.
 *
 * Each test owns a fresh building, so a ledger scoped to that building contains
 * exactly the residents that test created and the register is never in frame.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FeeLedgerResponseDto, FeeLedgerRowDto, MonthKey } from '@hostel/shared';
import { feeLedgerQuerySchema, isoDateToUtcDate, monthKeyToUtcDate } from '@hostel/shared';
import { ConflictError, UnprocessableError } from '../../lib/errors/app-error';
import { recordAudit } from '../../lib/services/audit.service';
import { getFeeLedger } from '../../lib/services/fee-ledger.service';
import {
  createPayment,
  deletePayment,
  settlePayment,
  updatePayment,
} from '../../lib/services/payment.service';
import {
  Fixtures,
  disconnect,
  integrationSuite,
  jsonObject,
  monthsAgo,
  monthsAhead,
  must,
  prisma,
  rolledBackTransaction,
  today,
} from '../helpers/db';

const suite = await integrationSuite();
const fixtures = new Fixtures();

/** A month whose due date is certainly behind us, whatever day the suite runs. */
const PAST_MONTH = monthsAgo(1);
/** A month whose due date is certainly ahead of us. */
const FUTURE_MONTH = monthsAhead(1);

const ledgerFor = (buildingId: string, month: MonthKey): Promise<FeeLedgerResponseDto> =>
  getFeeLedger(feeLedgerQuerySchema.parse({ buildingId, month }));

const rowFor = (ledger: FeeLedgerResponseDto, residentId: string): FeeLedgerRowDto =>
  must(
    ledger.rows.find((row) => row.residentId === residentId),
    `a ledger row for resident ${residentId}`,
  );

suite('fees (integration)', () => {
  beforeAll(async () => {
    await fixtures.setUp();
  });

  afterAll(async () => {
    await fixtures.tearDown();
    await disconnect();
  });

  it('prices a month per resident: expected, paid, balance and status', async () => {
    const building = await fixtures.createBuilding('Ledger block');
    const alice = await fixtures.createResident({
      name: 'Alice',
      buildingId: building.id,
      monthlyFee: 6000,
      dueDay: 5,
      joinMonth: monthsAgo(2),
    });
    const bob = await fixtures.createResident({
      name: 'Bob',
      buildingId: building.id,
      monthlyFee: 4500,
      dueDay: 10,
      joinMonth: PAST_MONTH,
    });
    // Joins next month, so last month is not their month at all.
    const carol = await fixtures.createResident({
      name: 'Carol',
      buildingId: building.id,
      monthlyFee: 3000,
      dueDay: 5,
      joinMonth: FUTURE_MONTH,
    });
    await fixtures.createPayment({
      residentId: alice.id,
      billingMonth: PAST_MONTH,
      amount: 2000,
    });

    const ledger = await ledgerFor(building.id, PAST_MONTH);

    expect(ledger.month).toBe(PAST_MONTH);
    expect(ledger.rows.map((row) => row.residentId)).toEqual([alice.id, bob.id]);

    const aliceRow = rowFor(ledger, alice.id);
    expect(aliceRow).toMatchObject({
      residentName: fixtures.label('Alice'),
      buildingId: building.id,
      buildingName: building.name,
      monthlyFee: 6000,
      dueDay: 5,
      dueDate: `${PAST_MONTH}-05`,
      expected: 6000,
      paid: 2000,
      balance: 4000,
      status: 'OVERDUE',
      paymentCount: 1,
    });
    expect(aliceRow.daysOverdue).toBeGreaterThan(0);

    expect(rowFor(ledger, bob.id)).toMatchObject({
      dueDate: `${PAST_MONTH}-10`,
      expected: 4500,
      paid: 0,
      balance: 4500,
      status: 'OVERDUE',
      paymentCount: 0,
    });

    // A resident who had not joined yet is absent, not a zero row.
    expect(ledger.rows.some((row) => row.residentId === carol.id)).toBe(false);

    expect(ledger.totals).toEqual({
      residentCount: 2,
      expected: 10500,
      paid: 2000,
      balance: 8500,
      // 2000 / 10500 = 19.05%
      collectionRate: 19,
    });
  });

  it('separates NOT_DUE, PART_PAID and PAID before the due date has passed', async () => {
    const building = await fixtures.createBuilding('Future block');
    const unpaid = await fixtures.createResident({
      name: 'Devi',
      buildingId: building.id,
      monthlyFee: 6000,
      dueDay: 5,
      joinMonth: PAST_MONTH,
    });
    const partial = await fixtures.createResident({
      name: 'Esha',
      buildingId: building.id,
      monthlyFee: 4500,
      dueDay: 5,
      joinMonth: PAST_MONTH,
    });
    const settled = await fixtures.createResident({
      name: 'Farid',
      buildingId: building.id,
      monthlyFee: 3000,
      dueDay: 5,
      joinMonth: PAST_MONTH,
    });

    await fixtures.createPayment({
      residentId: partial.id,
      billingMonth: FUTURE_MONTH,
      amount: 1000,
    });
    await fixtures.createPayment({
      residentId: settled.id,
      billingMonth: FUTURE_MONTH,
      amount: 3000,
    });

    const ledger = await ledgerFor(building.id, FUTURE_MONTH);

    expect(rowFor(ledger, unpaid.id)).toMatchObject({
      status: 'NOT_DUE',
      balance: 6000,
      daysOverdue: 0,
    });
    expect(rowFor(ledger, partial.id)).toMatchObject({
      status: 'PART_PAID',
      paid: 1000,
      balance: 3500,
      daysOverdue: 0,
    });
    expect(rowFor(ledger, settled.id)).toMatchObject({
      status: 'PAID',
      paid: 3000,
      balance: 0,
    });
    expect(ledger.totals).toMatchObject({
      residentCount: 3,
      expected: 13500,
      paid: 4000,
      balance: 9500,
    });
  });

  it('moves the ledger when a payment is recorded, and sums two payments in one month', async () => {
    const building = await fixtures.createBuilding('Recording block');
    const resident = await fixtures.createResident({
      name: 'Gita',
      buildingId: building.id,
      monthlyFee: 5000,
      dueDay: 5,
      joinMonth: PAST_MONTH,
    });

    const before = rowFor(await ledgerFor(building.id, PAST_MONTH), resident.id);
    expect(before).toMatchObject({ paid: 0, balance: 5000, paymentCount: 0 });

    const first = await createPayment(
      {
        residentId: resident.id,
        billingMonth: PAST_MONTH,
        amount: 2000,
        paymentMethod: 'CASH',
      },
      fixtures.auth,
    );
    expect(first).toMatchObject({
      residentId: resident.id,
      residentName: fixtures.label('Gita'),
      billingMonth: PAST_MONTH,
      amount: 2000,
      buildingId: building.id,
    });

    expect(rowFor(await ledgerFor(building.id, PAST_MONTH), resident.id)).toMatchObject({
      paid: 2000,
      balance: 3000,
      status: 'OVERDUE',
      paymentCount: 1,
    });

    // A top-up is a second row, never an edit of the first.
    const second = await createPayment(
      {
        residentId: resident.id,
        billingMonth: PAST_MONTH,
        amount: 1250,
        paymentMethod: 'UPI',
      },
      fixtures.auth,
    );
    expect(second.id).not.toBe(first.id);

    expect(rowFor(await ledgerFor(building.id, PAST_MONTH), resident.id)).toMatchObject({
      paid: 3250,
      balance: 1750,
      status: 'OVERDUE',
      paymentCount: 2,
    });

    const stored = await prisma.feePayment.findMany({ where: { residentId: resident.id } });
    expect(stored).toHaveLength(2);
    // Read straight off the documents, so these are paise: Rs 1,250 and Rs 2,000.
    expect(stored.map((row) => row.amount).sort((a, b) => a - b)).toEqual([125_000, 200_000]);
    expect(stored.every((row) => Number.isInteger(row.amount))).toBe(true);
  });

  it('refuses a payment for a month the resident was not staying in', async () => {
    const building = await fixtures.createBuilding('Guard block');
    const resident = await fixtures.createResident({
      name: 'Hari',
      buildingId: building.id,
      monthlyFee: 5000,
      dueDay: 5,
      joinMonth: PAST_MONTH,
    });

    await expect(
      createPayment(
        {
          residentId: resident.id,
          billingMonth: monthsAgo(6),
          amount: 5000,
          paymentMethod: 'CASH',
        },
        fixtures.auth,
      ),
    ).rejects.toThrow(UnprocessableError);

    expect(await prisma.feePayment.count({ where: { residentId: resident.id } })).toBe(0);
  });

  it('settles a month for the outstanding amount it works out itself, and refuses a second settle', async () => {
    const building = await fixtures.createBuilding('Settle block');
    const resident = await fixtures.createResident({
      name: 'Ila',
      buildingId: building.id,
      monthlyFee: 6000,
      dueDay: 5,
      joinMonth: PAST_MONTH,
    });
    await createPayment(
      {
        residentId: resident.id,
        billingMonth: PAST_MONTH,
        amount: 2500,
        paymentMethod: 'CASH',
      },
      fixtures.auth,
    );

    // Note what is NOT passed: the caller never states an amount.
    const settlement = await settlePayment(
      { residentId: resident.id, billingMonth: PAST_MONTH, paymentMethod: 'UPI' },
      fixtures.auth,
    );

    expect(settlement.amount).toBe(3500);
    expect(settlement.note).toBe('Arrears cleared');
    expect(settlement.paymentMethod).toBe('UPI');

    const settledRow = rowFor(await ledgerFor(building.id, PAST_MONTH), resident.id);
    expect(settledRow).toMatchObject({
      paid: 6000,
      balance: 0,
      status: 'PAID',
      paymentCount: 2,
      daysOverdue: 0,
    });

    await expect(
      settlePayment(
        { residentId: resident.id, billingMonth: PAST_MONTH, paymentMethod: 'CASH' },
        fixtures.auth,
      ),
    ).rejects.toThrow(ConflictError);

    // The refused settle wrote nothing.
    expect(await prisma.feePayment.count({ where: { residentId: resident.id } })).toBe(2);
  });

  it('restores the previous balance when a payment is deleted', async () => {
    const building = await fixtures.createBuilding('Reversal block');
    const resident = await fixtures.createResident({
      name: 'Jai',
      buildingId: building.id,
      monthlyFee: 7000,
      dueDay: 5,
      joinMonth: PAST_MONTH,
    });

    await createPayment(
      {
        residentId: resident.id,
        billingMonth: PAST_MONTH,
        amount: 2000,
        paymentMethod: 'CASH',
      },
      fixtures.auth,
    );
    const beforeSecond = rowFor(await ledgerFor(building.id, PAST_MONTH), resident.id);
    expect(beforeSecond).toMatchObject({ paid: 2000, balance: 5000, paymentCount: 1 });

    const mistake = await createPayment(
      {
        residentId: resident.id,
        billingMonth: PAST_MONTH,
        amount: 4400,
        paymentMethod: 'CASH',
      },
      fixtures.auth,
    );
    expect(rowFor(await ledgerFor(building.id, PAST_MONTH), resident.id)).toMatchObject({
      paid: 6400,
      balance: 600,
      paymentCount: 2,
    });

    const reversal = await deletePayment(mistake.id, fixtures.auth);
    expect(reversal).toEqual({ id: mistake.id, reversed: true });

    const afterDelete = rowFor(await ledgerFor(building.id, PAST_MONTH), resident.id);
    expect(afterDelete.paid).toBe(beforeSecond.paid);
    expect(afterDelete.balance).toBe(beforeSecond.balance);
    expect(afterDelete.paymentCount).toBe(beforeSecond.paymentCount);
    expect(afterDelete.status).toBe(beforeSecond.status);

    expect(await prisma.feePayment.findUnique({ where: { id: mistake.id } })).toBeNull();
  });

  it('writes exactly one audit row for every payment mutation', async () => {
    const building = await fixtures.createBuilding('Audit block');
    const resident = await fixtures.createResident({
      name: 'Kiran',
      buildingId: building.id,
      monthlyFee: 8000,
      dueDay: 5,
      joinMonth: PAST_MONTH,
    });

    /* ---- CREATE ---- */
    const payment = await createPayment(
      {
        residentId: resident.id,
        billingMonth: PAST_MONTH,
        amount: 3000,
        paymentMethod: 'CASH',
      },
      fixtures.auth,
    );

    const created = must(
      await prisma.auditLog.findFirst({
        where: { entityType: 'FEE_PAYMENT', entityId: payment.id, action: 'CREATE' },
      }),
      'the CREATE audit row',
    );
    expect(created.userId).toBe(fixtures.auth.userId);
    expect(created.summary).toContain(fixtures.label('Kiran'));
    expect(jsonObject(created.newData).amount).toBe(3000);

    // That the payment and this row commit together is proved by the rollback
    // probe in the next test; what matters here is that the mutation produced
    // exactly one row, never a duplicate and never none.
    expect(
      await prisma.auditLog.count({
        where: { entityType: 'FEE_PAYMENT', entityId: payment.id, action: 'CREATE' },
      }),
    ).toBe(1);

    /* ---- UPDATE ---- */
    const edited = await updatePayment(payment.id, { amount: 3500 }, fixtures.auth);
    expect(edited.amount).toBe(3500);

    const updated = must(
      await prisma.auditLog.findFirst({
        where: { entityType: 'FEE_PAYMENT', entityId: payment.id, action: 'UPDATE' },
      }),
      'the UPDATE audit row',
    );
    // The payload is the DTO, so these are rupees either side of the edit.
    expect(jsonObject(updated.oldData).amount).toBe(3000);
    expect(jsonObject(updated.newData).amount).toBe(3500);
    expect(
      await prisma.auditLog.count({
        where: { entityType: 'FEE_PAYMENT', entityId: payment.id, action: 'UPDATE' },
      }),
    ).toBe(1);
    // The stored document moved with it, in paise.
    expect(
      must(await prisma.feePayment.findUnique({ where: { id: payment.id } }), 'the edited payment')
        .amount,
    ).toBe(350_000);

    /* ---- CREATE, via settle ---- */
    const settlement = await settlePayment(
      { residentId: resident.id, billingMonth: PAST_MONTH, paymentMethod: 'CASH' },
      fixtures.auth,
    );
    const settled = must(
      await prisma.auditLog.findFirst({
        where: { entityType: 'FEE_PAYMENT', entityId: settlement.id, action: 'CREATE' },
      }),
      'the settle audit row',
    );
    expect(jsonObject(settled.newData).amount).toBe(4500);
    expect(
      await prisma.auditLog.count({
        where: { entityType: 'FEE_PAYMENT', entityId: settlement.id, action: 'CREATE' },
      }),
    ).toBe(1);

    /* ---- DELETE ---- */
    await deletePayment(settlement.id, fixtures.auth);
    const deleted = must(
      await prisma.auditLog.findFirst({
        where: { entityType: 'FEE_PAYMENT', entityId: settlement.id, action: 'DELETE' },
      }),
      'the DELETE audit row',
    );
    // The row is gone; the trail still holds what it contained.
    expect(await prisma.feePayment.findUnique({ where: { id: settlement.id } })).toBeNull();
    expect(jsonObject(deleted.oldData)).toMatchObject({
      id: settlement.id,
      amount: 4500,
      billingMonth: PAST_MONTH,
      residentName: fixtures.label('Kiran'),
    });

    const trail = await prisma.auditLog.findMany({
      where: { entityType: 'FEE_PAYMENT', entityId: { in: [payment.id, settlement.id] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(trail.map((row) => row.action)).toEqual(['CREATE', 'UPDATE', 'CREATE', 'DELETE']);
  });

  it('rolls a payment and its audit row back together when the transaction fails', async () => {
    const building = await fixtures.createBuilding('Atomic block');
    const resident = await fixtures.createResident({
      name: 'Lata',
      buildingId: building.id,
      monthlyFee: 5000,
      dueDay: 5,
      joinMonth: PAST_MONTH,
    });
    const before = await prisma.feePayment.count({ where: { residentId: resident.id } });

    /*
     * PostgreSQL stamped both rows with the same `xmin`, which is how this
     * suite used to show a payment and its audit row were written by one
     * transaction. MongoDB has no such stamp - so the guarantee is proved by
     * breaking it: make exactly the writes payment.service makes, on one
     * transaction client, then fail the way a dropped connection would. If the
     * two writes were not atomic, one of them would be left behind.
     */
    const written = await rolledBackTransaction(async (tx) => {
      const payment = await tx.feePayment.create({
        data: {
          residentId: resident.id,
          billingMonth: monthKeyToUtcDate(PAST_MONTH),
          // Written straight through Prisma, so paise: Rs 1,500.00.
          amount: 150_000,
          paymentDate: isoDateToUtcDate(today()),
          paymentMethod: 'CASH',
          note: 'Probe payment that must never survive',
          createdById: fixtures.auth.userId,
        },
      });
      await recordAudit(tx, {
        auth: fixtures.auth,
        action: 'CREATE',
        entityType: 'FEE_PAYMENT',
        entityId: payment.id,
        summary: 'Probe audit row that must never survive',
        newData: { amount: payment.amount },
      });
      const audit = must(
        await tx.auditLog.findFirst({
          where: { entityType: 'FEE_PAYMENT', entityId: payment.id },
        }),
        'the audit row, inside the transaction',
      );
      // Both documents are readable here, inside the transaction...
      return { paymentId: payment.id, auditId: audit.id, amount: payment.amount };
    });

    expect(written.amount).toBe(150_000);

    // ...and neither of them exists outside it.
    expect(await prisma.feePayment.findUnique({ where: { id: written.paymentId } })).toBeNull();
    expect(await prisma.auditLog.findUnique({ where: { id: written.auditId } })).toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { entityType: 'FEE_PAYMENT', entityId: written.paymentId },
      }),
    ).toBe(0);
    expect(await prisma.feePayment.count({ where: { residentId: resident.id } })).toBe(before);

    // The ledger is unmoved: the whole month is still owed.
    expect(rowFor(await ledgerFor(building.id, PAST_MONTH), resident.id)).toMatchObject({
      paid: 0,
      balance: 5000,
      paymentCount: 0,
    });
  });
});
