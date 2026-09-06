/**
 * The resident lifecycle against a real MongoDB replica set.
 *
 * The rules under test are the ones that are only true once a document has
 * actually been through the database: a joining month stored as the FIRST day
 * of that month and a vacating month as its LAST day, at UTC midnight; an
 * archive that preserves the books; a hard delete reserved for someone who
 * never transacted; a transfer that updates the resident and writes its history
 * document in one transaction.
 *
 * MongoDB enforces none of that for us - there are no foreign keys and no
 * referential actions - so these are the tests that stand in for the database
 * constraints the PostgreSQL schema used to carry.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { isoDateToUtcDate, monthBuildingQuerySchema, utcDateToIsoDate } from '@hostel/shared';
import { ConflictError } from '../../lib/errors/app-error';
import {
  createResident,
  deleteResident,
  getResidentProfile,
  moveResident,
  vacateResident,
} from '../../lib/services/resident.service';
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

const profileQuery = (month?: string): ReturnType<typeof monthBuildingQuerySchema.parse> =>
  monthBuildingQuerySchema.parse(month ? { buildingId: 'all', month } : { buildingId: 'all' });

suite('residents (integration)', () => {
  beforeAll(async () => {
    await fixtures.setUp();
  });

  afterAll(async () => {
    await fixtures.tearDown();
    await disconnect();
  });

  it('stores the joining month as its first day and the vacating month as its last', async () => {
    const building = await fixtures.createBuilding('Lifecycle block');

    const dto = await createResident(
      {
        name: fixtures.label('Lakshmi'),
        buildingId: building.id,
        monthlyFee: 5500,
        dueDay: 7,
        joinMonth: '2027-02',
        vacatedMonth: '2027-04',
      },
      fixtures.auth,
    );

    expect(dto).toMatchObject({
      joinDate: '2027-02-01',
      joinMonth: '2027-02',
      vacatedDate: '2027-04-30',
      vacatedMonth: '2027-04',
    });

    const stored = must(
      await prisma.resident.findUnique({ where: { id: dto.id } }),
      'the stored resident',
    );
    // Pinned to UTC midnight, so no timezone can shift the business day.
    expect(stored.joinDate.toISOString()).toBe('2027-02-01T00:00:00.000Z');
    expect(must(stored.vacatedDate, 'a vacated date').toISOString()).toBe(
      '2027-04-30T00:00:00.000Z',
    );

    // The opening entry of the transfer history starts on the joining date.
    const moves = await prisma.residentBuildingHistory.findMany({ where: { residentId: dto.id } });
    expect(moves).toHaveLength(1);
    expect(must(moves[0], 'the opening move row')).toMatchObject({
      fromBuildingId: null,
      toBuildingId: building.id,
    });
    expect(utcDateToIsoDate(must(moves[0], 'the opening move row').effectiveDate)).toBe(
      '2027-02-01',
    );

    // February in a leap year is 29 days, and the clamp has to know that.
    const leap = await createResident(
      {
        name: fixtures.label('Meena'),
        buildingId: building.id,
        monthlyFee: 4000,
        dueDay: 31,
        joinMonth: '2028-01',
        vacatedMonth: '2028-02',
      },
      fixtures.auth,
    );
    expect(leap.vacatedDate).toBe('2028-02-29');

    // Vacating later moves the stored date to the last day of the new month.
    const vacated = await vacateResident(dto.id, { vacatedMonth: '2027-11' }, fixtures.auth);
    expect(vacated).toMatchObject({ vacatedDate: '2027-11-30', vacatedMonth: '2027-11' });
    const reread = must(
      await prisma.resident.findUnique({ where: { id: dto.id } }),
      'the vacated resident',
    );
    expect(must(reread.vacatedDate, 'a vacated date').toISOString()).toBe(
      '2027-11-30T00:00:00.000Z',
    );
  });

  it('archives a resident who has payments and keeps every payment', async () => {
    const building = await fixtures.createBuilding('Archive block');
    const resident = await createResident(
      {
        name: fixtures.label('Nadia'),
        buildingId: building.id,
        monthlyFee: 6000,
        dueDay: 5,
        joinMonth: monthsAgo(1),
      },
      fixtures.auth,
    );
    const payment = await fixtures.createPayment({
      residentId: resident.id,
      billingMonth: monthsAgo(1),
      amount: 6000,
    });

    const result = await deleteResident(resident.id, fixtures.auth);

    expect(result.archived).toBe(true);
    expect(result.resident.active).toBe(false);

    const stored = must(
      await prisma.resident.findUnique({ where: { id: resident.id } }),
      'the archived resident',
    );
    expect(stored.active).toBe(false);
    expect(stored.archivedAt).not.toBeNull();

    const survivor = must(
      await prisma.feePayment.findUnique({ where: { id: payment.id } }),
      'the retained payment',
    );
    expect(survivor.residentId).toBe(resident.id);
    // Read off the document, so paise: Rs 6,000.00 exactly.
    expect(survivor.amount).toBe(600_000);

    const audit = must(
      await prisma.auditLog.findFirst({
        where: { entityType: 'RESIDENT', entityId: resident.id, action: 'ARCHIVE' },
      }),
      'the ARCHIVE audit row',
    );
    expect(audit.summary).toContain('1 payment(s) retained');
  });

  it('hard-deletes a resident who never paid anything', async () => {
    const building = await fixtures.createBuilding('Mistake block');
    const resident = await createResident(
      {
        name: fixtures.label('Omkar'),
        buildingId: building.id,
        monthlyFee: 5000,
        dueDay: 5,
        joinMonth: monthsAgo(1),
      },
      fixtures.auth,
    );

    const result = await deleteResident(resident.id, fixtures.auth);

    expect(result.archived).toBe(false);
    expect(await prisma.resident.findUnique({ where: { id: resident.id } })).toBeNull();
    // The building history described a person who never transacted; it goes too.
    expect(
      await prisma.residentBuildingHistory.count({ where: { residentId: resident.id } }),
    ).toBe(0);

    const audit = must(
      await prisma.auditLog.findFirst({
        where: { entityType: 'RESIDENT', entityId: resident.id, action: 'DELETE' },
      }),
      'the DELETE audit row',
    );
    expect(jsonObject(audit.oldData).name).toBe(fixtures.label('Omkar'));
  });

  it('moves a resident, writing the history row and the new building in one transaction', async () => {
    const from = await fixtures.createBuilding('From block');
    const to = await fixtures.createBuilding('To block');
    const resident = await createResident(
      {
        name: fixtures.label('Pooja'),
        buildingId: from.id,
        monthlyFee: 5000,
        dueDay: 5,
        joinMonth: monthsAgo(2),
      },
      fixtures.auth,
    );

    const { resident: moved, move } = await moveResident(
      resident.id,
      { toBuildingId: to.id, effectiveDate: today(), notes: 'Room swap' },
      fixtures.auth,
    );

    expect(moved.buildingId).toBe(to.id);
    expect(moved.buildingName).toBe(to.name);
    expect(move).toMatchObject({
      residentId: resident.id,
      fromBuildingId: from.id,
      fromBuildingName: from.name,
      toBuildingId: to.id,
      toBuildingName: to.name,
      effectiveDate: today(),
      notes: 'Room swap',
    });

    const stored = must(
      await prisma.resident.findUnique({ where: { id: resident.id } }),
      'the moved resident',
    );
    expect(stored.buildingId).toBe(to.id);

    const history = await prisma.residentBuildingHistory.findMany({
      where: { residentId: resident.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history).toHaveLength(2);
    expect(must(history[1], 'the move row').id).toBe(move.id);

    /*
     * The transfer and its record commit together. There is no `xmin` on
     * MongoDB to compare, so the property is proved by breaking it: move the
     * resident back and write the matching history document on one transaction
     * client, then fail. Neither half may survive - a resident whose building
     * moved without a history row, or a history row describing a move that
     * never happened, are exactly the two states this must exclude.
     */
    const probe = await rolledBackTransaction(async (tx) => {
      const reverted = await tx.resident.update({
        where: { id: resident.id },
        data: { buildingId: from.id },
      });
      const row = await tx.residentBuildingHistory.create({
        data: {
          residentId: resident.id,
          fromBuildingId: to.id,
          toBuildingId: from.id,
          effectiveDate: isoDateToUtcDate(today()),
          notes: 'Probe move that must never survive',
        },
      });
      // Inside the transaction the move back has happened.
      return { buildingId: reverted.buildingId, historyId: row.id };
    });
    expect(probe.buildingId).toBe(from.id);

    // Outside it, neither write landed.
    expect(
      must(
        await prisma.resident.findUnique({ where: { id: resident.id } }),
        'the resident after the aborted move',
      ).buildingId,
    ).toBe(to.id);
    expect(
      await prisma.residentBuildingHistory.findUnique({ where: { id: probe.historyId } }),
    ).toBeNull();
    expect(
      await prisma.residentBuildingHistory.count({ where: { residentId: resident.id } }),
    ).toBe(2);

    await expect(
      moveResident(resident.id, { toBuildingId: to.id }, fixtures.auth),
    ).rejects.toThrow(ConflictError);
    expect(
      await prisma.residentBuildingHistory.count({ where: { residentId: resident.id } }),
    ).toBe(2);
  });

  it('covers exactly the billable months in the profile history', async () => {
    const building = await fixtures.createBuilding('Profile block');

    const staying = await createResident(
      {
        name: fixtures.label('Ravi'),
        buildingId: building.id,
        monthlyFee: 5000,
        dueDay: 5,
        joinMonth: monthsAgo(2),
      },
      fixtures.auth,
    );
    await fixtures.createPayment({
      residentId: staying.id,
      billingMonth: monthsAgo(1),
      amount: 5000,
    });

    const left = await createResident(
      {
        name: fixtures.label('Sunita'),
        buildingId: building.id,
        monthlyFee: 4000,
        dueDay: 5,
        joinMonth: monthsAgo(3),
        vacatedMonth: monthsAgo(1),
      },
      fixtures.auth,
    );

    const stayingProfile = await getResidentProfile(staying.id, profileQuery());
    // Newest first, from the joining month up to this month - no earlier, no later.
    expect(stayingProfile.monthlyHistory.map((row) => row.month)).toEqual([
      monthsAgo(0),
      monthsAgo(1),
      monthsAgo(2),
    ]);
    expect(stayingProfile.monthlyHistory[0]).toMatchObject({
      month: monthsAgo(0),
      expected: 5000,
      paid: 0,
      balance: 5000,
    });
    expect(stayingProfile.monthlyHistory[1]).toMatchObject({
      month: monthsAgo(1),
      expected: 5000,
      paid: 5000,
      balance: 0,
      status: 'PAID',
      paymentCount: 1,
    });
    expect(stayingProfile.monthlyHistory[2]).toMatchObject({
      month: monthsAgo(2),
      balance: 5000,
      status: 'OVERDUE',
    });
    expect(stayingProfile.totals.totalPaid).toBe(5000);
    expect(stayingProfile.totals.paymentCount).toBe(1);
    expect(stayingProfile.totals.outstandingAllMonths).toBe(10000);
    expect(stayingProfile.payments).toHaveLength(1);

    // The vacating month is billed in full and the history stops there.
    const leftProfile = await getResidentProfile(left.id, profileQuery());
    expect(leftProfile.monthlyHistory.map((row) => row.month)).toEqual([
      monthsAgo(1),
      monthsAgo(2),
      monthsAgo(3),
    ]);
    expect(leftProfile.monthlyHistory.every((row) => row.expected === 4000)).toBe(true);
    expect(leftProfile.totals.outstandingAllMonths).toBe(12000);
    expect(leftProfile.totals.overdue.oldestUnpaidMonth).toBe(monthsAgo(3));
    expect(leftProfile.totals.overdue.numberOfOverdueMonths).toBe(3);
    expect(leftProfile.totals.overdue.totalOverdue).toBe(12000);

    // Browsing ahead extends a staying resident's history but can never extend
    // one that is bounded by a vacating month.
    const ahead = await getResidentProfile(staying.id, profileQuery(monthsAhead(2)));
    expect(ahead.monthlyHistory.map((row) => row.month)).toEqual([
      monthsAhead(2),
      monthsAhead(1),
      monthsAgo(0),
      monthsAgo(1),
      monthsAgo(2),
    ]);
    const leftAhead = await getResidentProfile(left.id, profileQuery(monthsAhead(2)));
    expect(leftAhead.monthlyHistory.map((row) => row.month)).toEqual([
      monthsAgo(1),
      monthsAgo(2),
      monthsAgo(3),
    ]);
  });
});
