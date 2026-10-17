/** S5 consumer: remap on editable receipts, audit-only rejection, org check, cursor, catch-up. */
import { beforeEach, expect, it } from "vitest";
import { fixturesForSeam } from "@checkin/receipt-contract-fixtures";
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

  it("replay is a no-op: a re-applied event changes nothing and audits nothing new", async () => {
    await provisionalLine("pending_review");
    const rejected = event(6, "provisional_rejected", { provisionalGtin13: "2000000000022", rejectionReason: "dup" });
    await orgEventConsumer.onOrgEvents([approved(5), rejected]);
    await orgEventConsumer.onOrgEvents([approved(5), rejected]);
    expect(await db.workflowAuditLog.count({ where: { eventType: "line_remapped" } })).toBe(1);
    expect(await db.workflowAuditLog.count({ where: { eventType: "provisional_rejected" } })).toBe(1);
  });

  it("an event committed after a higher id is still applied, and the cursor does not move back", async () => {
    const ls = await provisionalLine("pending_review");
    await orgEventConsumer.onOrgEvents([event(8, "provisional_rejected", { provisionalGtin13: "2000000000022", rejectionReason: "dup" })]);
    await orgEventConsumer.onOrgEvents([approved(7)]);
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).assignedGtin13).toBe(REAL);
    expect(await cursor()).toBe(8);
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

  it("replays past a bad event, records it, and retries it by id", async () => {
    const asked: number[] = [];
    const poison = event(3, "provisional_approved", { bad: true });
    configure({
      catalogEventSource: {
        eventsSince: async (_org, since) => {
          asked.push(since);
          return [approved(1), approved(2), poison, approved(4)].filter((e) => e.id > since);
        },
      },
    });
    expect(await catchUpOrgEvents()).toEqual({ applied: 3, failed: 1 });
    expect(await cursor()).toBe(4);
    expect(await db.workflowFailedOrgEvent.findMany()).toMatchObject([{ id: 3, eventType: "provisional_approved" }]);

    // The recorded failure is retried by id from its stored payload, not re-read from the window.
    expect(await catchUpOrgEvents()).toEqual({ applied: 3, failed: 1 });
    expect(asked).toEqual([0, 0]);
  });

  it("a bad event in the post-commit call-out does not block later events, and a fixed retry clears it", async () => {
    const ls = await provisionalLine("pending_review");
    await orgEventConsumer.onOrgEvents([event(3, "provisional_approved", { bad: true }), approved(4)]);

    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).assignedGtin13).toBe(REAL);
    expect(await cursor()).toBe(4);
    expect(await db.workflowFailedOrgEvent.count()).toBe(1);

    // A failure that clears (the stored payload now applies) is removed from the record.
    await db.workflowFailedOrgEvent.update({ where: { id: 3 }, data: { payload: approved(3).payload } });
    expect(await catchUpOrgEvents()).toEqual({ applied: 1, failed: 0 });
    expect(await db.workflowFailedOrgEvent.count()).toBe(0);
  });

  it("catch-up re-reads behind the cursor, so an event that committed late is not skipped", async () => {
    const ls = await provisionalLine("pending_review");
    // Event 8 committed and was applied first; event 7 committed after it.
    await orgEventConsumer.onOrgEvents([event(8, "provisional_rejected", { provisionalGtin13: "2000000000022", rejectionReason: "dup" })]);
    configure({ catalogEventSource: { eventsSince: async (_org, since) => [approved(7), event(8, "provisional_rejected", { provisionalGtin13: "2000000000022", rejectionReason: "dup" })].filter((e) => e.id > since) } });

    expect(await catchUpOrgEvents()).toEqual({ applied: 2, failed: 0 });

    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).assignedGtin13).toBe(REAL);
    expect(await db.workflowAuditLog.count({ where: { eventType: "provisional_rejected" } })).toBe(1);
    expect(await cursor()).toBe(8);
  });
});
