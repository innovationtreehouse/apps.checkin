import { it, expect, beforeEach } from 'vitest';
import { describeDb } from "../helpers/db";
import { db } from '../../db';
import { sendDisbursementEvent } from '../../workflows/disbursement.actor';
import { makeFile, makeTransaction, makeAccountMapRule, makeHold, makeEvent, TEST_ORG_ID } from '../helpers/factories';

const orgId = TEST_ORG_ID;
let fileId: number;

beforeEach(async () => {
  await db.disbursementEvent.deleteMany({});
  await db.disbursementHold.deleteMany({});
  await db.disbursementSnapshot.deleteMany({});
  await db.transaction.deleteMany({});
  await db.uploadedFile.deleteMany({});
  await db.accountMap.deleteMany({});

  const file = await makeFile(orgId);
  fileId = file.id;
});

// ── No-op for completed disbursements ─────────────────────────────────────────

describeDb('completed disbursement idempotence', () => {
  it('does nothing when a disbursement_events row already exists', async () => {
    await makeEvent(orgId, 'disb-done');
    await sendDisbursementEvent(orgId, 'disb-done', { type: 'OWNER_ASSIGNED', allReady: true });

    const events = await db.disbursementEvent.findMany({
      where: { orgId, disbursementId: 'disb-done' },
    });
    expect(events).toHaveLength(1);
  });
});

// ── Guard blocks non-ready assignments ───────────────────────────────────────

describeDb('guard: allOwnersReady', () => {
  it('does not create a snapshot when allReady=false', async () => {
    await makeTransaction(orgId, fileId, { disbursementId: 'disb-partial' });
    await sendDisbursementEvent(orgId, 'disb-partial', { type: 'OWNER_ASSIGNED', allReady: false });

    const snap = await db.disbursementSnapshot.findFirst({
      where: { orgId, disbursementId: 'disb-partial' },
    });
    expect(snap).toBeNull();
  });

  it('proceeds to processing when allReady=true', async () => {
    const disbursementId = 'disb-ready';
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1 });
    await makeAccountMapRule(orgId);

    await sendDisbursementEvent(orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady: true });

    const events = await db.disbursementEvent.findMany({
      where: { orgId, disbursementId },
    });
    expect(events).toHaveLength(1);
  });
});

// ── Account unresolved: creates holds + snapshot ───────────────────────────────

describeDb('account unresolved handling', () => {
  it('creates holds and an on_hold snapshot when no account map rule matches', async () => {
    const disbursementId = 'disb-no-match';
    const tx1 = await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, companyName: 'Unknown A' });
    const tx2 = await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, companyName: 'Unknown B' });

    await sendDisbursementEvent(orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady: true });

    const holds = await db.disbursementHold.findMany({
      where: { orgId, disbursementId },
    });
    expect(holds).toHaveLength(2);
    expect(holds.every(h => h.reason === 'NO_MATCH')).toBe(true);
    expect(holds.every(h => h.status === 'PENDING')).toBe(true);
    expect(holds.map(h => h.transactionId).sort()).toEqual([tx1.id, tx2.id].sort());

    const snap = await db.disbursementSnapshot.findFirst({
      where: { orgId, disbursementId },
    });
    expect(snap).toBeDefined();
    expect(snap!.state).toBe('on_hold');
    expect(snap!.version).toBe(0);
  });

  it('creates a MULTIPLE_MATCHES hold when two rules both match', async () => {
    const disbursementId = 'disb-multi-match';
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1 });
    await makeAccountMapRule(orgId, { companyName: '*', corporatePeerCampaign: '*', donationAccount: '4000' });
    await makeAccountMapRule(orgId, { companyName: 'Acme Corp', corporatePeerCampaign: '*', donationAccount: '4099' });

    await sendDisbursementEvent(orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady: true });

    const holds = await db.disbursementHold.findMany({
      where: { orgId, disbursementId },
    });
    expect(holds).toHaveLength(1);
    expect(holds[0].reason).toBe('MULTIPLE_MATCHES');
  });

  it('does not create a disbursement event when any transaction conflicts', async () => {
    const disbursementId = 'disb-partial-conflict';
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, companyName: 'Acme Corp' });
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, companyName: 'No Match Corp' });
    await makeAccountMapRule(orgId, { companyName: 'Acme Corp' });

    await sendDisbursementEvent(orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady: true });

    const events = await db.disbursementEvent.findMany({});
    expect(events).toHaveLength(0);

    const holds = await db.disbursementHold.findMany({});
    expect(holds.length).toBeGreaterThan(0);
  });
});

// ── Successful processing ──────────────────────────────────────────────────────

describeDb('successful processing', () => {
  it('creates a disbursement event and deletes the snapshot on success', async () => {
    const disbursementId = 'disb-success';
    await makeTransaction(orgId, fileId, {
      disbursementId,
      ownerId: 1,
      donationAmountCents: 100,
      matchAmountCents: 50,
      causeSupportFeeCents: 5,
      merchantFeeCents: 2,
      checkFeeCents: 1,
      disbursementDate: '2025-06-01',
      disbursementFrom: 'Benevity',
    });
    await makeAccountMapRule(orgId);

    await sendDisbursementEvent(orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady: true });

    const [event] = await db.disbursementEvent.findMany({
      where: { orgId, disbursementId },
    });
    expect(event).toBeDefined();

    const payload = JSON.parse(event.payload);
    expect(payload.disbursementId).toBe(disbursementId);
    expect(payload.disbursementDate).toBe('2025-06-01');
    expect(payload.disbursementFrom).toBe('Benevity');
    const types = payload.items.map((i: { type: string }) => i.type);
    expect(types).toContain('donation');
    expect(types).toContain('match');
    expect(types).toContain('fees');

    const snap = await db.disbursementSnapshot.findFirst({
      where: { orgId, disbursementId },
    });
    expect(snap).toBeNull();
  });

  it('excludes zero-amount line items from the payload', async () => {
    const disbursementId = 'disb-zeros';
    await makeTransaction(orgId, fileId, {
      disbursementId, ownerId: 1,
      donationAmountCents: 100, matchAmountCents: 0,
      causeSupportFeeCents: 0, merchantFeeCents: 0, checkFeeCents: 0,
    });
    await makeAccountMapRule(orgId);

    await sendDisbursementEvent(orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady: true });

    const [event] = await db.disbursementEvent.findMany({
      where: { orgId, disbursementId },
    });
    const types = JSON.parse(event.payload).items.map((i: { type: string }) => i.type);
    expect(types).toContain('donation');
    expect(types).not.toContain('match');
    expect(types).not.toContain('fees');
  });

  it('is idempotent — second send is a no-op', async () => {
    const disbursementId = 'disb-idempotent';
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1 });
    await makeAccountMapRule(orgId);

    await sendDisbursementEvent(orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady: true });
    await expect(
      sendDisbursementEvent(orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady: true })
    ).resolves.toBeUndefined();

    const events = await db.disbursementEvent.findMany({
      where: { orgId, disbursementId },
    });
    expect(events).toHaveLength(1);
  });
});

// ── Hold resubmission cycle ────────────────────────────────────────────────────

describeDb('hold resubmit lifecycle', () => {
  it('resolves holds and completes when account determination succeeds on resubmit', async () => {
    const disbursementId = 'disb-resubmit';
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, companyName: 'Unknown Corp' });

    await sendDisbursementEvent(orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady: true });

    const holdsBefore = await db.disbursementHold.findMany({
      where: { orgId, disbursementId },
    });
    expect(holdsBefore.every(h => h.status === 'PENDING')).toBe(true);

    await makeAccountMapRule(orgId, { companyName: 'Unknown Corp' });
    await sendDisbursementEvent(orgId, disbursementId, { type: 'HOLD_RESUBMITTED' });

    const holdsAfter = await db.disbursementHold.findMany({
      where: { orgId, disbursementId },
    });
    expect(holdsAfter.every(h => h.status === 'RESOLVED')).toBe(true);

    const events = await db.disbursementEvent.findMany({
      where: { orgId, disbursementId },
    });
    expect(events).toHaveLength(1);

    const snap = await db.disbursementSnapshot.findFirst({
      where: { orgId, disbursementId },
    });
    expect(snap).toBeNull();
  });

  it('cycles hold→processing→hold and bumps snapshot version', async () => {
    const disbursementId = 'disb-cycle';
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, companyName: 'Unknown Corp' });

    await sendDisbursementEvent(orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady: true });
    const snap1 = await db.disbursementSnapshot.findFirst({
      where: { orgId, disbursementId },
    });
    expect(snap1!.version).toBe(0);

    await sendDisbursementEvent(orgId, disbursementId, { type: 'HOLD_RESUBMITTED' });
    const snap2 = await db.disbursementSnapshot.findFirst({
      where: { orgId, disbursementId },
    });
    expect(snap2!.version).toBe(1);
    expect(snap2!.state).toBe('on_hold');

    const holds = await db.disbursementHold.findMany({
      where: { orgId, disbursementId },
    });
    expect(holds.filter(h => h.status === 'PENDING').length).toBeGreaterThan(0);
    expect(holds.filter(h => h.status === 'RESOLVED').length).toBeGreaterThan(0);
  });

  it('aggregates fees correctly after resubmit', async () => {
    const disbursementId = 'disb-fees-resubmit';
    await makeTransaction(orgId, fileId, {
      disbursementId, ownerId: 1, companyName: 'Unknown Corp',
      causeSupportFeeCents: 3, merchantFeeCents: 2, checkFeeCents: 1,
    });

    await sendDisbursementEvent(orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady: true });

    await makeAccountMapRule(orgId, { companyName: 'Unknown Corp' });
    await sendDisbursementEvent(orgId, disbursementId, { type: 'HOLD_RESUBMITTED' });

    const [event] = await db.disbursementEvent.findMany({
      where: { orgId, disbursementId },
    });
    const feesItem = JSON.parse(event.payload).items.find((i: { type: string }) => i.type === 'fees');
    expect(feesItem?.amountCents).toBe(6);
  });
});

// ── Illegal transition propagation ────────────────────────────────────────────

describeDb('illegal transition handling', () => {
  it('rejects HOLD_RESUBMITTED sent to awaiting_ownership (machine governs transitions)', async () => {
    const disbursementId = 'disb-illegal';
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: null });

    // The disbursement was never held, so HOLD_RESUBMITTED is illegal from
    // awaiting_ownership. The machine is authoritative: the event is rejected
    // (not silently dropped), the transaction rolls back, and nothing is written.
    await expect(
      sendDisbursementEvent(orgId, disbursementId, { type: 'HOLD_RESUBMITTED' }),
    ).rejects.toThrow(/Cannot apply 'HOLD_RESUBMITTED' in state 'awaiting_ownership'/);

    const snap = await db.disbursementSnapshot.findFirst({
      where: { orgId, disbursementId },
    });
    expect(snap).toBeNull();

    const holds = await db.disbursementHold.findMany({
      where: { orgId, disbursementId },
    });
    expect(holds).toHaveLength(0);
  });

  it('is a no-op when disbursement already completed and OWNER_ASSIGNED sent again', async () => {
    const disbursementId = 'disb-complete-guard';
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, companyName: 'Acme Corp' });
    await makeAccountMapRule(orgId, { companyName: 'Acme Corp' });

    await sendDisbursementEvent(orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady: true });

    const eventsBefore = await db.disbursementEvent.findMany({
      where: { orgId, disbursementId },
    });
    expect(eventsBefore).toHaveLength(1);

    // Second call must be a no-op, not throw
    await expect(
      sendDisbursementEvent(orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady: true })
    ).resolves.toBeUndefined();

    const eventsAfter = await db.disbursementEvent.findMany({
      where: { orgId, disbursementId },
    });
    expect(eventsAfter).toHaveLength(1);
  });

  it('creates one hold per conflicting transaction', async () => {
    const disbursementId = 'disb-multi-tx-hold';
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, companyName: 'NoRule Corp' });
    await makeTransaction(orgId, fileId, { disbursementId, ownerId: 1, companyName: 'AlsoNoRule Corp' });

    await sendDisbursementEvent(orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady: true });

    const holds = await db.disbursementHold.findMany({
      where: { orgId, disbursementId },
    });
    expect(holds).toHaveLength(2);
    expect(holds.every(h => h.reason === 'NO_MATCH')).toBe(true);
  });
});
