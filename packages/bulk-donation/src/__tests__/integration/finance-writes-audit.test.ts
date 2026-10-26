/**
 * FINANCE writes outside the disbursement cycle each record one workflow_events row,
 * attributed to the caller, in the same transaction as the write.
 */
import { it, expect, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { rules, uploads } from "../../routes";
import { makeFile, configureTestRuntime, TEST_ORG_ID } from "../helpers/factories";

const orgId = TEST_ORG_ID;
const req = (method: string, body?: unknown) =>
  new Request("http://test/api/donations", {
    method,
    headers: { "x-correlation-id": "corr-fin-1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(async () => {
  await db.workflowEvent.deleteMany({});
  await db.donationQbMatchExclusion.deleteMany({});
  await db.transactionCommentRule.deleteMany({});
  await db.transaction.deleteMany({});
  await db.uploadedFile.deleteMany({});
  configureTestRuntime();
});

async function onlyEvent() {
  const events = await db.workflowEvent.findMany({ where: { orgId } });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ actorUserId: 1, actorUsername: "testfinance", correlationId: "corr-fin-1" });
  return events[0];
}

describeDb("FINANCE writes are audited", () => {
  it("deleting a comment rule records COMMENT_RULE_DELETED without the donor comment", async () => {
    const rule = await db.transactionCommentRule.create({
      data: { orgId, comment: "for the robotics team", ownerId: 9, createdByUserId: 1 },
    });

    await rules.deleteCommentRule({ req: req("DELETE"), params: { id: String(rule.id) } });

    const event = await onlyEvent();
    expect(event).toMatchObject({ entityType: "comment_rule", entityId: String(rule.id), eventType: "COMMENT_RULE_DELETED" });
    expect(event.payload).not.toContain("robotics");
    expect(await db.transactionCommentRule.count()).toBe(0);
  });

  it("dropping an all-duplicate upload's blob records FILE_BLOB_DELETED", async () => {
    const file = await makeFile(orgId);
    await db.uploadedFile.update({ where: { id: file.id }, data: { allDuplicate: true } });

    await uploads.deleteBlob({ req: req("DELETE"), params: { id: String(file.id) } });

    const event = await onlyEvent();
    expect(event).toMatchObject({ entityType: "uploaded_file", entityId: String(file.id), eventType: "FILE_BLOB_DELETED" });
  });

});
