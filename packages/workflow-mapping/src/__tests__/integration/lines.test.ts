/** Line decisions: associate (CI3), propose, non-inventory, the 409 rule, auto-proceed, actor attribution. */
import { beforeEach, expect, it } from "vitest";
import type { CatalogItemReferenceProposal, CatalogProvisionalItemProposal, CatalogReferenceConflict } from "@inventory/receipt-types";
import { db } from "../../db";
import type { CatalogReader, CatalogSubmissions, RefCheckResult } from "../../contract";
import { lineItemService } from "../../services/lineItemService";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { MANAGER, OTHER_ORG_ID, clearAll, configure, makeLineStatus, makeReceipt, recordingSinks } from "../helpers/setup";

const noRef = { exists: false, gtin13: null, id: null, conversionFactor: 1, conversionVersion: 1 };
let refCheck: RefCheckResult;
let submitted: {
  proposals: CatalogItemReferenceProposal[];
  conflicts: CatalogReferenceConflict[];
  provisionals: CatalogProvisionalItemProposal[];
};
let sinks: ReturnType<typeof recordingSinks>;

function catalog(): { catalogReader: CatalogReader; catalogSubmissions: CatalogSubmissions } {
  return {
    catalogReader: { lookupItems: async () => [], checkReferences: async () => refCheck },
    catalogSubmissions: {
      proposeItemReference: async (p) => (submitted.proposals.push(p), { id: 1 }),
      reportConflict: async (p) => (submitted.conflicts.push(p), { id: 2 }),
      allocateProvisionalGtin: async () => "2000000000015",
      proposeProvisionalItem: async (p) => void submitted.provisionals.push(p),
    },
  };
}

beforeEach(async () => {
  await clearAll();
  refCheck = { mfr_part: noRef, retailer_part: noRef, mfr_desc: noRef, wouldCreateNewReference: true };
  submitted = { proposals: [], conflicts: [], provisionals: [] };
  sinks = recordingSinks();
  configure({ ...catalog(), ...sinks });
});

async function pendingWithLines(n = 1) {
  const r = await makeReceipt({ state: "pending_review", lineCount: n });
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(await makeLineStatus(r.id, { receiptLineItemId: i, recognitionStatus: "unrecognized" }));
  return { r, lines };
}

describeDb("associate (CI3, optimistic)", () => {
  it("recognizes the line at once and proposes a new reference stamped with the principal's id", async () => {
    const { r, lines } = await pendingWithLines(2);
    await lineItemService.associateGtin(r.id, lines[0].id, { gtin13: "0000000000017", conversionFactor: 4 });
    const ls = await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: lines[0].id } });
    expect(ls).toMatchObject({ recognitionStatus: "recognized", assignedGtin13: "0000000000017", conversionFactor: 4 });
    expect(submitted.proposals).toHaveLength(1);
    // The payload's submitterId (4242) is data, never the actor.
    expect(submitted.proposals[0].localUserId).toBe(MANAGER.id);
    const audit = await db.workflowAuditLog.findFirstOrThrow({ where: { eventType: "line_associated" } });
    expect(audit).toMatchObject({ actorUserId: MANAGER.id, actorUsername: MANAGER.name });
  });

  it("reports a conflict when an existing reference has a different GTIN", async () => {
    refCheck.mfr_part = { exists: true, gtin13: "0000000000024", id: 9, conversionFactor: 1, conversionVersion: 1 };
    const { r, lines } = await pendingWithLines(2);
    await lineItemService.associateGtin(r.id, lines[0].id, { gtin13: "0000000000017" });
    expect(submitted.conflicts).toEqual([
      expect.objectContaining({ itemReferenceId: 9, existingGtin13: "0000000000024", proposedGtin13: "0000000000017", manufacturer: "Acme", partNumber: "PN-1" }),
    ]);
  });

  it("502 and the line unchanged when the catalog is not wired", async () => {
    configure(sinks);
    const { r, lines } = await pendingWithLines();
    await expect(lineItemService.associateGtin(r.id, lines[0].id, { gtin13: "0000000000017" })).rejects.toMatchObject({ status: 502 });
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: lines[0].id } })).recognitionStatus).toBe("unrecognized");
  });

  it("404 for another org's receipt and for a line of another receipt", async () => {
    const foreign = await makeReceipt({ orgId: OTHER_ORG_ID });
    const fl = await makeLineStatus(foreign.id, { recognitionStatus: "unrecognized" });
    await expect(lineItemService.markNonInventory(foreign.id, fl.id)).rejects.toMatchObject({ status: 404 });
    const { r } = await pendingWithLines();
    await expect(lineItemService.markNonInventory(r.id, fl.id)).rejects.toMatchObject({ status: 404 });
  });
});

describeDb("propose", () => {
  it("allocates a provisional GTIN, proposes it, and marks the line provisional", async () => {
    const { r, lines } = await pendingWithLines(2);
    const res = await lineItemService.proposeProvisionalItem(r.id, lines[0].id, {
      proposedName: "Widget",
      proposedCategoryId: 1,
      proposedSubcategoryId: 2,
      proposedUsageBehavior: "Durable",
      conversionFactor: 5,
    });
    expect(res).toEqual({ provisionalGtin13: "2000000000015" });
    expect(submitted.provisionals[0]).toMatchObject({ provisionalGtin13: "2000000000015", localUserId: MANAGER.id, conversionFactor: 5 });
    expect(await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: lines[0].id } })).toMatchObject({
      recognitionStatus: "provisional",
      provisionalItemGtin13: "2000000000015",
    });
  });
});

describeDb("non-inventory and auto-proceed", () => {
  it("resolving the last line proceeds and pushes", async () => {
    const { r, lines } = await pendingWithLines(2);
    await lineItemService.markNonInventory(r.id, lines[0].id);
    expect((await db.receivedReceipt.findUniqueOrThrow({ where: { id: r.id } })).state).toBe("pending_review");
    await lineItemService.associateGtin(r.id, lines[1].id, { gtin13: "0000000000017" });
    expect((await db.receivedReceipt.findUniqueOrThrow({ where: { id: r.id } })).state).toBe("resolved");
    expect(sinks.calls.inventory[0].lineItems).toHaveLength(1);
  });
});

describeDb("line edits are refused on applying and resolved receipts", () => {
  for (const state of ["applying", "resolved"] as const) {
    it(`409 on ${state} for every line decision`, async () => {
      const r = await makeReceipt({ state });
      const ls = await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
      await expect(lineItemService.markNonInventory(r.id, ls.id)).rejects.toMatchObject({ status: 409 });
      await expect(lineItemService.associateGtin(r.id, ls.id, { gtin13: "0000000000024" })).rejects.toMatchObject({ status: 409 });
      await expect(
        lineItemService.proposeProvisionalItem(r.id, ls.id, { proposedName: "x", proposedCategoryId: 1, proposedSubcategoryId: 1, proposedUsageBehavior: "Durable" }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).toMatchObject({
        recognitionStatus: "recognized",
        assignedGtin13: "0000000000017",
      });
      expect(submitted.proposals).toHaveLength(0);
    });
  }

  it("edits stay allowed on apply_failed (and do not auto-proceed)", async () => {
    const r = await makeReceipt({ state: "apply_failed" });
    const ls = await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    await lineItemService.markNonInventory(r.id, ls.id);
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).recognitionStatus).toBe("non_inventory");
    expect((await db.receivedReceipt.findUniqueOrThrow({ where: { id: r.id } })).state).toBe("apply_failed");
  });
});

describeDb("an id-less session is unauthenticated", () => {
  it("401 on every write and read, nothing written", async () => {
    const { r, lines } = await pendingWithLines();
    configure({ ...catalog(), ...sinks, principal: { id: Number.NaN, name: "ghost" } });
    const calls = [
      () => lineItemService.associateGtin(r.id, lines[0].id, { gtin13: "0000000000017" }),
      () => lineItemService.markNonInventory(r.id, lines[0].id),
      () => lineItemService.proposeProvisionalItem(r.id, lines[0].id, { proposedName: "x", proposedCategoryId: 1, proposedSubcategoryId: 1, proposedUsageBehavior: "Durable" }),
      () => receiptService.proceed(r.id),
      () => receiptService.apply(r.id),
      () => receiptService.retryApply(r.id),
      () => receiptService.list(),
      () => receiptService.counts(),
      () => receiptService.detail(r.id),
      () => receiptService.auditLog(),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ status: 401 });
    expect(await db.workflowAuditLog.count()).toBe(0);
  });
});
