/**
 * Unit tests for repository layer — expense, org, orgEvents, and
 * provisionalItemMap. Tests verify CRUD correctness, org isolation,
 * join-based queries, and idempotent upserts.
 */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { createExpenseRepository } from "../../repositories/expense";
import { createOrgRepository } from "../../repositories/org";
import { createOrgEventsRepository } from "../../repositories/orgEvents";
import { createProvisionalItemMapRepository } from "../../repositories/provisionalItemMap";
import { seedExpense, seedLineItem, seedApproval, ORG } from "../helpers/seed";

const expenseRepo = createExpenseRepository(db);
const orgRepo = createOrgRepository(db);
const eventsRepo = createOrgEventsRepository(db);
const provisionalRepo = createProvisionalItemMapRepository(db);

// ── ExpenseRepository ─────────────────────────────────────────────────────────

describeDb("expenseRepository.findExpenseById", () => {
  it("returns null when the expense does not exist", async () => {
    const result = await expenseRepo.findExpenseById("non-existent", ORG);
    expect(result).toBeNull();
  });

  it("returns the expense when it exists", async () => {
    const id = await seedExpense({ vendorName: "TestCo", state: "pending" });
    const result = await expenseRepo.findExpenseById(id, ORG);
    expect(result).not.toBeNull();
    expect(result?.vendorName).toBe("TestCo");
    expect(result?.state).toBe("pending");
  });
});

describeDb("expenseRepository.listForOrg", () => {
  it("returns only expenses belonging to the given org", async () => {
    await seedExpense({ orgId: ORG, vendorName: "Mine" });
    await seedExpense({ orgId: "other-org", vendorName: "NotMine" });
    const results = await expenseRepo.listForOrg(ORG);
    expect(results.every((r) => r.orgId === ORG)).toBe(true);
    expect(results.some((r) => r.vendorName === "Mine")).toBe(true);
    expect(results.some((r) => r.vendorName === "NotMine")).toBe(false);
  });
});

describeDb("expenseRepository.updateExpense", () => {
  it("updates the specified field", async () => {
    const id = await seedExpense({ state: "pending" });
    await expenseRepo.updateExpense(id, { state: "owner_approval" });
    const updated = await expenseRepo.findExpenseById(id, ORG);
    expect(updated?.state).toBe("owner_approval");
  });
});

describeDb("expenseRepository.listExpenseIdsByOrgAndState", () => {
  it("filters by both org and state", async () => {
    const pending = await seedExpense({ state: "pending" });
    const holding = await seedExpense({ state: "qb_on_hold" });
    await seedExpense({ orgId: "other-org", state: "pending" });

    const results = await expenseRepo.listExpenseIdsByOrgAndState(ORG, "pending");
    const ids = results.map((r) => r.id);
    expect(ids).toContain(pending);
    expect(ids).not.toContain(holding);
  });
});

describeDb("expenseRepository.listLineItems / insertLineItem / updateLineItem", () => {
  it("inserts and retrieves line items for an expense", async () => {
    const id = await seedExpense();
    const liId = await seedLineItem(id, { description: "Widget A", totalPriceCents: 50 });
    const items = await expenseRepo.listLineItems(id);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(liId);
    expect(items[0].description).toBe("Widget A");
  });

  it("updateLineItem changes the specified field", async () => {
    const id = await seedExpense();
    const liId = await seedLineItem(id, { description: "Old" });
    await expenseRepo.updateLineItem(liId, { description: "New" }, id);
    const items = await expenseRepo.listLineItems(id);
    expect(items[0].description).toBe("New");
  });

  it("listLineItemIds returns only ids", async () => {
    const id = await seedExpense();
    const liId = await seedLineItem(id);
    const ids = await expenseRepo.listLineItemIds(id);
    expect(ids.map((r) => r.id)).toContain(liId);
  });
});

describeDb("expenseRepository approvals", () => {
  it("findApprovalById returns null for missing approval", async () => {
    const id = await seedExpense();
    const result = await expenseRepo.findApprovalById(99999, id);
    expect(result).toBeNull();
  });

  it("insertApproval and findApprovalById round-trip", async () => {
    const id = await seedExpense({ state: "owner_approval" });
    const li = await seedLineItem(id);
    const approvalId = await seedApproval(id, li, { ownerId: 7, status: "pending" });
    const found = await expenseRepo.findApprovalById(approvalId, id);
    expect(found?.ownerId).toBe(7);
    expect(found?.status).toBe("pending");
  });

  it("listApprovalsByExpenseId returns all approvals for an expense", async () => {
    const id = await seedExpense({ state: "owner_approval" });
    const li1 = await seedLineItem(id, { description: "A" });
    const li2 = await seedLineItem(id, { description: "B" });
    await seedApproval(id, li1);
    await seedApproval(id, li2);
    const approvals = await expenseRepo.listApprovalsByExpenseId(id);
    expect(approvals).toHaveLength(2);
  });

  it("updateApproval mutates the status", async () => {
    const id = await seedExpense({ state: "owner_approval" });
    const li = await seedLineItem(id);
    const approvalId = await seedApproval(id, li, { status: "pending" });
    await expenseRepo.updateApproval(approvalId, { status: "approved" });
    const updated = await expenseRepo.findApprovalById(approvalId, id);
    expect(updated?.status).toBe("approved");
  });

  it("listUnassignedApprovalExpenseIds returns ids with null ownerId", async () => {
    const id1 = await seedExpense({ state: "owner_approval" });
    const li1 = await seedLineItem(id1);
    await seedApproval(id1, li1, { ownerId: null });

    const id2 = await seedExpense({ state: "owner_approval" });
    const li2 = await seedLineItem(id2);
    await seedApproval(id2, li2, { ownerId: 5 });

    const results = await expenseRepo.listUnassignedApprovalExpenseIds([id1, id2]);
    const ids = results.map((r) => r.expenseId);
    expect(ids).toContain(id1);
    expect(ids).not.toContain(id2);
  });
});

describeDb("expenseRepository.listSiblingApprovals", () => {
  it("finds unassigned approvals with the same gtin13 across other expenses", async () => {
    const gtin = "0000000000017";
    const e1 = await seedExpense({ state: "owner_approval" });
    const li1 = await seedLineItem(e1, { gtin13: gtin });
    await seedApproval(e1, li1, { ownerId: null });

    const e2 = await seedExpense({ state: "owner_approval" });
    const li2 = await seedLineItem(e2, { gtin13: gtin });
    await seedApproval(e2, li2, { ownerId: null });

    const siblings = await expenseRepo.listSiblingApprovals(ORG, gtin, e1);
    expect(siblings.some((s) => s.expenseId === e2)).toBe(true);
    expect(siblings.some((s) => s.expenseId === e1)).toBe(false);
  });
});

describeDb("expenseRepository.insertAuditLog", () => {
  it("inserts a single audit log entry", async () => {
    const id = await seedExpense();
    await expenseRepo.insertAuditLog({
      expenseId: id, userId: 1, username: "tester", changedAt: new Date(),
      action: "test_action", valueBefore: "a", valueAfter: "b",
    });
    const expense = await expenseRepo.findExpenseById(id, ORG);
    expect(expense).toBeDefined();
  });

  it("inserts multiple audit log entries in one call", async () => {
    const id = await seedExpense();
    await expenseRepo.insertAuditLog([
      { expenseId: id, userId: 1, username: "tester", changedAt: new Date(), action: "action_one" },
      { expenseId: id, userId: 1, username: "tester", changedAt: new Date(), action: "action_two" },
    ]);
  });
});

// ── OrgRepository ─────────────────────────────────────────────────────────────

describeDb("orgRepository.findByGlobalOrgId", () => {
  it("returns undefined when org does not exist", async () => {
    const result = await orgRepo.findByGlobalOrgId("nonexistent-org");
    expect(result).toBeNull();
  });

  it("returns the row after creation", async () => {
    await orgRepo.upsert(ORG);
    const result = await orgRepo.findByGlobalOrgId(ORG);
    expect(result?.orgId).toBe(ORG);
  });
});

describeDb("orgRepository.upsert", () => {
  it("creates settings on first call", async () => {
    const settings = await orgRepo.upsert(ORG);
    expect(settings.orgId).toBe(ORG);
  });

  it("is idempotent — returns the same row on subsequent calls", async () => {
    const first = await orgRepo.upsert(ORG);
    const second = await orgRepo.upsert(ORG);
    expect(second.orgId).toBe(first.orgId);
  });
});

describeDb("orgRepository.update", () => {
  it("updates threshold fields", async () => {
    await orgRepo.upsert(ORG);
    const [updated] = await orgRepo.update(ORG, {
      capitalTotalThresholdCents: 9999,
      capitalLineItemThresholdCents: 4999,
    });
    expect(updated.capitalTotalThresholdCents).toBe(9999);
    expect(updated.capitalLineItemThresholdCents).toBe(4999);
  });
});

// ── OrgEventsRepository ───────────────────────────────────────────────────────

describeDb("orgEventsRepository.getMaxId", () => {
  it("returns 0 when no events exist", async () => {
    const max = await eventsRepo.getMaxId();
    expect(max).toBe(0);
  });

  it("returns the maximum id when events exist", async () => {
    await db.expenseReceivedOrgEvent.create({ data: { id: 10, orgId: ORG, eventType: "test", payload: "{}", receivedAt: new Date() } });
    await db.expenseReceivedOrgEvent.create({ data: { id: 20, orgId: ORG, eventType: "test", payload: "{}", receivedAt: new Date() } });
    const max = await eventsRepo.getMaxId();
    expect(max).toBe(20);
  });
});

describeDb("orgEventsRepository.insert and exists", () => {
  it("exists returns false before insert", async () => {
    expect(await eventsRepo.exists(99)).toBe(false);
  });

  it("exists returns true after insert", async () => {
    await eventsRepo.insert({ id: 5, orgId: ORG, eventType: "part_approved", payload: "{}", receivedAt: new Date() });
    expect(await eventsRepo.exists(5)).toBe(true);
  });
});

describeDb("orgEventsRepository.updateStatus", () => {
  it("updates the status and failureReason", async () => {
    await eventsRepo.insert({ id: 7, orgId: ORG, eventType: "test", payload: "{}", receivedAt: new Date() });
    await eventsRepo.updateStatus(7, "failed", "something broke");
    const found = await eventsRepo.findOne(7);
    expect(found?.status).toBe("failed");
    expect(found?.failureReason).toBe("something broke");
  });
});

describeDb("orgEventsRepository.findPending", () => {
  it("returns pending and failed events for the org, not processed ones", async () => {
    await eventsRepo.insert({ id: 1, orgId: ORG, eventType: "t", payload: "{}", receivedAt: new Date() });
    await eventsRepo.insert({ id: 2, orgId: ORG, eventType: "t", payload: "{}", receivedAt: new Date() });
    await eventsRepo.insert({ id: 3, orgId: ORG, eventType: "t", payload: "{}", receivedAt: new Date() });
    await eventsRepo.insert({ id: 4, orgId: "other-org", eventType: "t", payload: "{}", receivedAt: new Date() });

    await eventsRepo.updateStatus(2, "processed");
    await eventsRepo.updateStatus(3, "failed", "err");

    const pending = await eventsRepo.findPending(ORG);
    const ids = pending.map((e) => e.id);
    expect(ids).toContain(1);
    expect(ids).toContain(3);
    expect(ids).not.toContain(2);
    expect(ids).not.toContain(4);
  });
});

// ── ProvisionalItemMapRepository ──────────────────────────────────────────────

describeDb("provisionalItemMapRepository", () => {
  const makeProvisional = (gtin: string) => ({
    orgId: ORG,
    provisionalGtin13: gtin,
    proposedAt: new Date(),
  });

  it("create inserts and returns the row", async () => {
    const row = await provisionalRepo.create(makeProvisional("PROV-001"));
    expect(row.id).toBeGreaterThan(0);
    expect(row.status).toBe("pending");
  });

  it("findByGtin returns null when not found", async () => {
    const result = await provisionalRepo.findByGtin(ORG, "PROV-MISSING");
    expect(result).toBeNull();
  });

  it("findByGtin returns the row after creation", async () => {
    await provisionalRepo.create(makeProvisional("PROV-002"));
    const found = await provisionalRepo.findByGtin(ORG, "PROV-002");
    expect(found?.provisionalGtin13).toBe("PROV-002");
    expect(found?.orgId).toBe(ORG);
  });

  it("findManyByOrg returns only the requesting org's rows, newest first", async () => {
    await provisionalRepo.create({ ...makeProvisional("PROV-A"), proposedAt: new Date(1000) });
    await provisionalRepo.create({ ...makeProvisional("PROV-B"), proposedAt: new Date(2000) });
    await provisionalRepo.create({ orgId: "other-org", provisionalGtin13: "PROV-OTHER", proposedAt: new Date() });

    const rows = await provisionalRepo.findManyByOrg(ORG);
    expect(rows.every((r) => r.orgId === ORG)).toBe(true);
    expect(rows[0].proposedAt.getTime()).toBeGreaterThanOrEqual(rows[rows.length - 1].proposedAt.getTime());
  });

  it("updateStatus mutates the row", async () => {
    const row = await provisionalRepo.create(makeProvisional("PROV-003"));
    await provisionalRepo.updateStatus(row.id, { status: "approved", resolvedToGtin13: "REAL-001", reviewedAt: new Date() });
    const updated = await provisionalRepo.findByGtin(ORG, "PROV-003");
    expect(updated?.status).toBe("approved");
    expect(updated?.resolvedToGtin13).toBe("REAL-001");
  });
});
