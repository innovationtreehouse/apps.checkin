/** S5 consumer: remap on editable receipts, audit-only rejection, org check, cursor, catch-up. */
import { beforeEach, expect, it } from "vitest";
import { fixturesForSeam } from "@inventory/receipt-contract-fixtures";
import { db } from "../../db";
import type { OrgEventRecord } from "../../contract";
import { catchUpOrgEvents, orgEventConsumer } from "../../services/orgEventConsumer";
import { describeDb } from "../helpers/db";
import { OTHER_ORG_ID, TEST_ORG_ID, clearAll, configure, makeLineStatus, makeReceipt } from "../helpers/setup";

const PROV = "2000000000015";
const REAL = "0000000000017";

function event(id: number, eventType: string, body: Record<string, unknown>, orgId = TEST_ORG_ID): OrgEventRecord {
  return { id, orgId, eventType, payload: JSON.stringify({ version: 1, ...body }) };
}
const approved = (id: number, orgId?: string) =>
  event(id, "provisional_approved", { provisionalGtin13: PROV, realGtin13: REAL, name: "Widget", conversionFactor: 6, conversionVersion: 2 }, orgId);

async function provisionalLine(state: "pending_review" | "applying" | "apply_failed" | "resolved") {
  const r = await makeReceipt({ state });
  return makeLineStatus(r.id, { recognitionStatus: "provisional", provisionalItemGtin13: PROV });
}

async function cursor(): Promise<number> {
  return (await db.workflowSystemData.findUnique({ where: { id: 1 } }))?.orgEventCursor ?? 0;
}

beforeEach(async () => {
  await clearAll();
  configure();
});

describeDb("S5 remap", () => {
  it("remaps lines on pending_review and apply_failed receipts only", async () => {
    const pending = await provisionalLine("pending_review");
    const failed = await provisionalLine("apply_failed");
    const applying = await provisionalLine("applying");
    const resolved = await provisionalLine("resolved");

    await orgEventConsumer.onOrgEvents([approved(5)]);

    for (const ls of [pending, failed]) {
      expect(await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).toMatchObject({
        recognitionStatus: "recognized",
        assignedGtin13: REAL,
        conversionFactor: 6,
        conversionVersion: 2,
      });
    }
    for (const ls of [applying, resolved]) {
      expect(await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).toMatchObject({
        recognitionStatus: "provisional",
        assignedGtin13: null,
      });
    }
    expect(await db.workflowAuditLog.count({ where: { eventType: "line_remapped" } })).toBe(2);
    expect(await cursor()).toBe(5);
  });

  it("provisional_mapped_to_existing remaps the same way", async () => {
    const ls = await provisionalLine("pending_review");
    await orgEventConsumer.onOrgEvents([
      event(3, "provisional_mapped_to_existing", { provisionalGtin13: PROV, realGtin13: REAL }),
    ]);
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).assignedGtin13).toBe(REAL);
  });

  it("provisional_rejected is audit-only", async () => {
    const ls = await provisionalLine("pending_review");
    await orgEventConsumer.onOrgEvents([event(4, "provisional_rejected", { provisionalGtin13: PROV, rejectionReason: "dup" })]);
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).recognitionStatus).toBe("provisional");
    expect(await db.workflowAuditLog.count({ where: { eventType: "provisional_rejected" } })).toBe(1);
  });

  it("every shared S5 fixture is consumed without error", async () => {
    const fixtures = fixturesForSeam<{ eventType: string } & Record<string, unknown>>("S5-org-events");
    const events = fixtures.map(({ value }, i) => {
      const { eventType, ...rest } = value;
      return { id: i + 1, orgId: TEST_ORG_ID, eventType, payload: JSON.stringify(rest) };
    });
    await orgEventConsumer.onOrgEvents(events);
    expect(await cursor()).toBe(events.length);
  });

  it("replay is a no-op: events at or below the cursor are skipped", async () => {
    await provisionalLine("pending_review");
    await orgEventConsumer.onOrgEvents([approved(5)]);
    await orgEventConsumer.onOrgEvents([approved(5)]);
    expect(await db.workflowAuditLog.count({ where: { eventType: "line_remapped" } })).toBe(1);
  });

  it("an event for another org is rejected, audited, and the cursor advances past it", async () => {
    const ls = await provisionalLine("pending_review");
    await orgEventConsumer.onOrgEvents([approved(1, OTHER_ORG_ID), approved(2)]);
    expect(await cursor()).toBe(2);
    expect((await db.workflowAuditLog.findFirstOrThrow({ where: { eventType: "org_event_rejected" } })).details).toMatch(/"eventId":1/);
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).assignedGtin13).toBe(REAL);
  });
});

describeDb("catch-up sweep", () => {
  it("is a no-op with the inert event source", async () => {
    expect(await catchUpOrgEvents()).toEqual({ applied: 0, failed: 0 });
  });

  it("replays from the cursor, stops at the first failure, and returns counts only", async () => {
    const asked: number[] = [];
    configure({
      catalogEventSource: {
        eventsSince: async (_org, since) => {
          asked.push(since);
          return [approved(1), approved(2), event(3, "provisional_approved", { bad: true }), approved(4)].filter((e) => e.id > since);
        },
      },
    });
    expect(await catchUpOrgEvents()).toEqual({ applied: 2, failed: 1 });
    expect(await cursor()).toBe(2);
    expect(await catchUpOrgEvents({ limit: 1 })).toEqual({ applied: 0, failed: 1 });
    expect(asked).toEqual([0, 2]);
  });
});
