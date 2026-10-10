/**
 * Receipt mapping (#1289): the persona matrix over all 10 routes, and a manager
 * journey from proceed through apply into org inventory (X4). Real HTTP against
 * the running dev server and the seeded workflow-mapping DB (see
 * docker-compose.flow.yml + packages/workflow-mapping/prisma/seed.ts).
 *
 * Only X4 is bound: the expense leg (X5) is inert, so every push lands in
 * apply_failed after the inventory leg applies, and the catalog ports (X3)
 * answer 502 on associate/propose.
 */
import { loginAs, api, type Session } from "./helpers";

const MANAGER = "inventory.manager@example.com";
const FINANCE = "finance@example.com";
const BOARD = "boardmember@example.com";
const CATALOG_VIEWER = "keyholder1@example.com";
const MEMBER = "parent.family@example.com";

const READS = [
  "/api/workflow-mapping/receipts",
  "/api/workflow-mapping/receipts?state=pending_review",
  "/api/workflow-mapping/receipts/counts",
  "/api/workflow-mapping/receipts/1",
  "/api/workflow-mapping/audit-log",
];
const WRITES: Array<[string, unknown?]> = [
  ["/api/workflow-mapping/receipts/1/proceed"],
  ["/api/workflow-mapping/receipts/1/apply"],
  ["/api/workflow-mapping/receipts/1/retry-apply"],
  ["/api/workflow-mapping/receipts/1/lines/1/associate", { gtin13: "0022222222220" }],
  ["/api/workflow-mapping/receipts/1/lines/1/propose", {
    proposedName: "Denied", proposedCategoryId: 1, proposedSubcategoryId: 1, proposedUsageBehavior: "Consumable",
  }],
  ["/api/workflow-mapping/receipts/1/lines/1/non-inventory"],
];
const GTIN = "0022222222220";

type ReceiptRow = { id: number; receiptId?: string; state: string; vendorName?: string | null; validationNotes?: string | null };
type LineRow = { id: number; receiptLineItemId: number; recognitionStatus: string };
type Detail = {
  ReceivedReceipt: ReceiptRow & { inventoryAppliedAt: string | null; receiptJson?: unknown };
  WorkflowReceiptView: Record<string, unknown> & { lineItems: Array<Record<string, unknown>> };
  ReceivedReceiptLineStatus: LineRow[];
};
type AuditRow = { eventType: string; receivedReceiptId: number | null; actorUsername?: string | null };

const post = (s: Session, path: string, body?: unknown) =>
  api(s, path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function stock(s: Session): Promise<number> {
  const res = await api<{ existingQuantity: number }>(s, `/api/inventory/org-items/${GTIN}`);
  return res.status === 404 ? 0 : res.json.existingQuantity;
}

async function seeded(s: Session, vendor: string): Promise<ReceiptRow> {
  const rows = (await api<ReceiptRow[]>(s, "/api/workflow-mapping/receipts")).json;
  const row = rows.find((r) => r.vendorName === vendor);
  if (!row) throw new Error(`seeded receipt from "${vendor}" not found`);
  return row;
}

describe("workflow mapping — route auth", () => {
  it("rejects every route without a session", async () => {
    // CHECKIN_ENV=local resolves a cookieless request as the keyless kiosk (403); elsewhere 401.
    for (const path of READS) {
      expect([path, [401, 403].includes((await api(null, path)).status)]).toEqual([path, true]);
    }
    for (const [path, body] of WRITES) {
      const { status } = await api(null, path, { method: "POST", body: JSON.stringify(body ?? {}) });
      expect([path, [401, 403].includes(status)]).toEqual([path, true]);
    }
  });

  it("denies every route to a member and to a catalog viewer who holds no read role", async () => {
    for (const email of [MEMBER, CATALOG_VIEWER]) {
      const s = await loginAs(email);
      for (const path of READS) expect([email, path, (await api(s, path)).status]).toEqual([email, path, 403]);
      for (const [path, body] of WRITES) expect([email, path, (await post(s, path, body)).status]).toEqual([email, path, 403]);
    }
  });

  it("lets finance and the board read, and denies them every write", async () => {
    for (const email of [FINANCE, BOARD]) {
      const s = await loginAs(email);
      const { id } = await seeded(s, "Seed Supply");
      for (const path of READS.map((p) => p.replace("/receipts/1", `/receipts/${id}`))) {
        expect([email, path, (await api(s, path)).status]).toEqual([email, path, 200]);
      }
      for (const [path, body] of WRITES) expect([email, path, (await post(s, path, body)).status]).toEqual([email, path, 403]);
    }
  });

  it("never returns the stored receipt blob or submitter fields", async () => {
    const m = await loginAs(MANAGER);
    const { id } = await seeded(m, "Seed Supply");
    const detail = await api<Detail>(m, `/api/workflow-mapping/receipts/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.ReceivedReceipt.receiptJson).toBeUndefined();
    expect(JSON.stringify(detail.json)).not.toMatch(/submitterId|needsReimbursement|reimbursementFor/);
    expect(detail.json.WorkflowReceiptView.lineItems.length).toBe(2);
  });

  it("server-renders the receiving page", async () => {
    const m = await loginAs(MANAGER);
    expect((await api(m, "/inventory/receiving")).status).toBe(200);
  });
});

describe("workflow mapping — manager journey", () => {
  it("proceeds and applies a receipt into org inventory, holding it in apply_failed for the unwired expense leg", async () => {
    const m = await loginAs(MANAGER);
    const receipt = await seeded(m, "Seed Hardware");
    expect(receipt.state).toBe("pending_review");
    const before = await stock(m);

    expect((await post(m, `/api/workflow-mapping/receipts/${receipt.id}/proceed`)).json).toMatchObject({ state: "applying" });
    expect((await post(m, `/api/workflow-mapping/receipts/${receipt.id}/proceed`)).status).toBe(409);

    const applied = await post(m, `/api/workflow-mapping/receipts/${receipt.id}/apply`);
    expect(applied.status).toBe(200);
    expect(applied.json).toMatchObject({ state: "apply_failed", validationNotes: "ExpenseSink.pushReceipt not wired" });
    expect(await stock(m)).toBe(before + 5);

    const detail = await api<Detail>(m, `/api/workflow-mapping/receipts/${receipt.id}`);
    expect(detail.json.ReceivedReceipt.inventoryAppliedAt).not.toBeNull();
    const [line] = detail.json.ReceivedReceiptLineStatus;
    expect((await post(m, `/api/workflow-mapping/receipts/${receipt.id}/lines/${line.id}/non-inventory`)).status).toBe(409);

    // Retry pushes only the legs not yet applied: stock is not counted twice.
    expect((await post(m, `/api/workflow-mapping/receipts/${receipt.id}/retry-apply`)).json).toMatchObject({ state: "applying" });
    expect((await post(m, `/api/workflow-mapping/receipts/${receipt.id}/apply`)).json).toMatchObject({ state: "apply_failed" });
    expect(await stock(m)).toBe(before + 5);

    const counts = await api<Record<string, number>>(m, "/api/workflow-mapping/receipts/counts");
    expect(counts.json.apply_failed).toBeGreaterThanOrEqual(1);
    const failed = await api<ReceiptRow[]>(m, "/api/workflow-mapping/receipts?state=apply_failed,applying");
    expect(failed.json.some((r) => r.id === receipt.id)).toBe(true);
    const log = await api<AuditRow[]>(m, `/api/workflow-mapping/audit-log?receiptId=${receipt.id}`);
    expect(log.json.map((e) => e.eventType)).toEqual(expect.arrayContaining(["receipt_proceeded", "receipt_apply_failed", "receipt_retry_started"]));
    expect(log.json.find((e) => e.eventType === "receipt_proceeded")?.actorUsername).toBe("Inventory Manager");
  });

  it("resolves the last line by marking it non-inventory, which auto-proceeds and applies", async () => {
    const m = await loginAs(MANAGER);
    const receipt = await seeded(m, "Seed Supply");
    const detail = await api<Detail>(m, `/api/workflow-mapping/receipts/${receipt.id}`);
    const open = detail.json.ReceivedReceiptLineStatus.find((l) => l.recognitionStatus === "unrecognized")!;
    const before = await stock(m);
    const line = `/api/workflow-mapping/receipts/${receipt.id}/lines/${open.id}`;

    // The catalog ports are not bound yet, so associate and propose fail loudly.
    expect((await post(m, `${line}/associate`, { gtin13: GTIN })).status).toBe(502);
    expect((await post(m, `${line}/propose`, {
      proposedName: "Towels", proposedCategoryId: 1, proposedSubcategoryId: 1, proposedUsageBehavior: "Consumable",
    })).status).toBe(502);
    expect((await post(m, `${line}/associate`, { gtin13: "" })).status).toBe(400);

    expect((await post(m, `${line}/non-inventory`)).status).toBe(200);
    const after = await api<Detail>(m, `/api/workflow-mapping/receipts/${receipt.id}`);
    expect(after.json.ReceivedReceipt.state).toBe("apply_failed");
    expect(await stock(m)).toBe(before + 2);
  });
});
