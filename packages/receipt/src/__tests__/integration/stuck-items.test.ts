/** The Problems list's read port: receipts stuck in the flow or on a failed push, with their page and latest failure time. */
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { stuckItems } from "../../stuckItems";
import { describeDb } from "../helpers/db";
import { ALICE, TEST_ORG_ID, clearAll, configure } from "../helpers/setup";

async function makeReceipt(state: string, opts: { orgId?: string; pushed?: boolean; audits?: { action: string; at: Date }[] } = {}): Promise<string> {
  const orgId = opts.orgId ?? TEST_ORG_ID;
  const id = randomUUID();
  await db.receipt.create({
    data: {
      id,
      orgId,
      uploadedByUserId: ALICE.id,
      fileBlob: Buffer.from("receipt"),
      fileHash: randomUUID(),
      mimeType: "text/plain",
      pushedAt: opts.pushed ? new Date() : null,
      details: { create: { orgId, state } },
      auditLogs: { create: (opts.audits ?? []).map((a) => ({ action: a.action, changedAt: a.at, valueAfter: "failure text" })) },
    },
  });
  return id;
}

beforeEach(async () => {
  await clearAll();
  configure();
});

describeDb("stuckItems", () => {
  it("lists a flow error and a failed push, each with its page and latest failure time", async () => {
    const first = new Date("2026-11-01T10:00:00Z");
    const latest = new Date("2026-11-02T10:00:00Z");
    const flow = await makeReceipt("flow_error", { audits: [{ action: "pipeline_failed", at: first }, { action: "pipeline_failed", at: latest }] });
    const push = await makeReceipt("receipt_finalized", { audits: [{ action: "push_failed", at: first }] });

    const items = await stuckItems();

    expect(items).toHaveLength(2);
    expect(items).toEqual(expect.arrayContaining([
      { id: flow, step: "flow", href: `/receipts/${flow}`, failedAt: latest },
      { id: push, step: "push to mapping", href: `/receipts/${push}`, failedAt: first },
    ]));
  });

  it("leaves out a pushed receipt, one never failed, and another org's", async () => {
    const at = new Date();
    await makeReceipt("receipt_finalized", { pushed: true, audits: [{ action: "push_failed", at }] });
    await makeReceipt("receipt_finalized");
    await makeReceipt("flow_error", { orgId: "00000000-0000-0000-0000-000000000099", audits: [{ action: "pipeline_failed", at }] });

    expect(await stuckItems()).toEqual([]);
  });
});
