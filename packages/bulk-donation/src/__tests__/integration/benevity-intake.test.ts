/**
 * Benevity intake through the services: upload + dedup, owner assignment against the owner
 * directory, comment rules, donor-read auditing, nav counts, and the pre-seated QB match state.
 */
import { it, expect, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { parseBenevityCsv } from "../../lib/csv-parser";
import { uploadedFileService } from "../../services/uploadedFileService";
import { transactionService } from "../../services/transactionService";
import { commentRuleService } from "../../services/commentRuleService";
import { getNavCounts } from "../../services/navCountsService";
import { benevityTakeoverLine, QB_MATCH_STATE, recordQbMatched } from "../../lib/qb-match";
import { ServiceError } from "../../services/serviceError";
import { makeAccountMapRule, configureTestRuntime, TEST_ORG_ID } from "../helpers/factories";

const orgId = TEST_ORG_ID;
const AUDIT = { actorUserId: 1, actorUsername: "testfinance", correlationId: "corr-intake" };
const READER = { actorUserId: 1, actorUsername: "testfinance", route: "/api/donations/transactions" };

const HEADER =
  "Disbursement ID,Disbursement Date,Company Name,Transaction ID,Donation Amount,Match Amount,Cause Support Fee,Donation Method,Donation Type,Donor First Name,Donor Last Name,Donor Comment";
const DONOR_FIELDS = ["Jane", "Doe", "Robotics team", "John", "Smith"];
const DONOR_KEYS = ["donorFirstName", "donorLastName", "donorComment"];

function csv(rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join("\n"));
}

async function upload(rows: string[]) {
  const buffer = csv(rows);
  return uploadedFileService.processUpload(orgId, 1, "testfinance", "benevity.csv", buffer, parseBenevityCsv(buffer), "corr-intake");
}

const FILE = [
  "D-1,2026-09-01,Acme Corp,T-1,100.00,50.00,2.50,check,standard,Jane,Doe,Robotics team",
  "D-1,2026-09-01,Acme Corp,T-2,20.00,0,0,check,standard,John,Smith,Robotics team",
  "D-1,2026-09-01,Acme Corp,T-3,10.00,0,0,check,standard,Ann,Lee,",
];

beforeEach(async () => {
  await db.workflowEvent.deleteMany({});
  await db.disbursementEvent.deleteMany({});
  await db.disbursementHold.deleteMany({});
  await db.disbursementSnapshot.deleteMany({});
  await db.transactionCommentRule.deleteMany({});
  await db.transaction.deleteMany({});
  await db.uploadedFile.deleteMany({});
  await db.accountMap.deleteMany({});
  await db.donationQbMatchExclusion.deleteMany({});
  configureTestRuntime();
});

describeDb("upload and dedup", () => {
  it("inserts new rows, auto-marks comment-less gifts organizational-level, and re-upload is a no-op", async () => {
    const first = await upload(FILE);
    expect(first).toMatchObject({ rowCount: 3, newRowCount: 3, duplicateRowCount: 0, allDuplicate: false });
    const t3 = await db.transaction.findFirstOrThrow({ where: { orgId, transactionId: "T-3" } });
    expect(t3.isOrganizationalLevel).toBe(true);

    const again = await upload(FILE);
    expect(again).toMatchObject({ rowCount: 3, newRowCount: 0, duplicateRowCount: 3, allDuplicate: true });
    expect(await db.transaction.count({ where: { orgId } })).toBe(3);

    expect(await uploadedFileService.deleteBlob(orgId, again.id)).toEqual({ id: again.id, blobDeleted: true });
    await expect(uploadedFileService.deleteBlob(orgId, first.id)).rejects.toBeInstanceOf(ServiceError);
  });

  it("file listing never selects the blob", async () => {
    await upload(FILE);
    const [file] = await uploadedFileService.listFiles(orgId);
    expect(file).not.toHaveProperty("fileBlob");
  });
});

describeDb("owner assignment", () => {
  it("rejects an owner the directory does not list, and an archived one", async () => {
    await upload(FILE);
    const t1 = await db.transaction.findFirstOrThrow({ where: { orgId, transactionId: "T-1" } });
    await expect(transactionService.assignOwner(orgId, t1.id, 12345, false, AUDIT)).rejects.toThrow("Unknown owner");
    await expect(transactionService.assignOwner(orgId, t1.id, 99, false, AUDIT)).rejects.toThrow(/archived/);
    expect((await db.transaction.findUniqueOrThrow({ where: { id: t1.id } })).ownerId).toBeNull();
  });

  it("a comment rule bulk-assigns identical comments and the disbursement completes", async () => {
    await makeAccountMapRule(orgId);
    await upload(FILE);
    const t1 = await db.transaction.findFirstOrThrow({ where: { orgId, transactionId: "T-1" } });
    await transactionService.assignOwner(orgId, t1.id, 201, true, AUDIT);

    const t2 = await db.transaction.findFirstOrThrow({ where: { orgId, transactionId: "T-2" } });
    expect(t2.ownerId).toBe(201);
    const event = await db.disbursementEvent.findFirstOrThrow({ where: { orgId, disbursementId: "D-1" } });
    expect(event.qbMatchState).toBe(QB_MATCH_STATE.UNMATCHED);
    expect(event.qbTxnId).toBeNull();
    expect(await getNavCounts(orgId)).toEqual({ unassignedQueue: 0, disbursementHolds: 0 });
  });

  it("the owner and organizational-level writes return no donor field", async () => {
    await upload(FILE);
    const t1 = await db.transaction.findFirstOrThrow({ where: { orgId, transactionId: "T-1" } });
    const t2 = await db.transaction.findFirstOrThrow({ where: { orgId, transactionId: "T-2" } });
    const assigned = await transactionService.assignOwner(orgId, t1.id, 201, false, AUDIT);
    const orgLevel = await transactionService.markOrganizationalLevel(orgId, t2.id, AUDIT);
    for (const row of [assigned, orgLevel]) {
      for (const key of DONOR_KEYS) expect(row).not.toHaveProperty(key);
    }
    expect(assigned).toMatchObject({ id: t1.id, ownerId: 201 });
    expect(orgLevel).toMatchObject({ id: t2.id, isOrganizationalLevel: true });
  });
});

describeDb("comment rules apply at upload", () => {
  it("a later upload whose comment matches a rule takes its owner, attributed to the uploader", async () => {
    await upload(FILE);
    const t1 = await db.transaction.findFirstOrThrow({ where: { orgId, transactionId: "T-1" } });
    await transactionService.assignOwner(orgId, t1.id, 201, true, AUDIT);

    await upload(["D-2,2026-09-08,Acme Corp,T-4,5.00,0,0,check,standard,Bo,Kim,Robotics team"]);
    const t4 = await db.transaction.findFirstOrThrow({ where: { orgId, transactionId: "T-4" } });
    expect(t4.ownerId).toBe(201);
    expect(t4.ownerAssignedByUserId).toBe(1);
    const rule = await db.transactionCommentRule.findFirstOrThrow({ where: { orgId, comment: "Robotics team" } });
    const evt = await db.workflowEvent.findFirstOrThrow({ where: { orgId, eventType: "OWNER_ASSIGNED", entityId: String(t4.id) } });
    expect(JSON.parse(evt.payload!)).toEqual({ ownerId: 201, viaCommentRule: true, commentRuleId: rule.id });
  });

  it("a rule pointing at an archived owner leaves the gift unassigned", async () => {
    await db.transactionCommentRule.create({ data: { orgId, comment: "Robotics team", ownerId: 99, createdByUserId: 1 } });
    await upload(FILE);
    const t1 = await db.transaction.findFirstOrThrow({ where: { orgId, transactionId: "T-1" } });
    expect(t1.ownerId).toBeNull();
  });
});

describeDb("upload runs the owner-assigned cycle per new disbursement", () => {
  async function ruleFor(comment: string, ownerId: number) {
    await db.transactionCommentRule.create({ data: { orgId, comment, ownerId, createdByUserId: 1 } });
  }

  it("a disbursement fully assigned at upload completes, attributed to the uploader", async () => {
    await makeAccountMapRule(orgId);
    await ruleFor("Robotics team", 201);
    await upload([
      ...FILE,
      "D-2,2026-09-01,Acme Corp,T-5,7.00,0,0,check,standard,Al,Ng,",
    ]);

    for (const disbursementId of ["D-1", "D-2"]) {
      await db.disbursementEvent.findFirstOrThrow({ where: { orgId, disbursementId } });
      expect(await db.disbursementSnapshot.count({ where: { orgId, disbursementId } })).toBe(0);
    }
    const completed = await db.workflowEvent.findFirstOrThrow({ where: { orgId, disbursementId: "D-1", eventType: "DISBURSEMENT_COMPLETED" } });
    expect(completed.actorUserId).toBe(1);
    expect(completed.correlationId).toBe("corr-intake");
    expect(await getNavCounts(orgId)).toEqual({ unassignedQueue: 0, disbursementHolds: 0 });
  });

  it("a partly assigned disbursement waits for ownership, and a fully assigned one with no account map goes on hold", async () => {
    await ruleFor("Robotics team", 201);
    await upload([
      "D-1,2026-09-01,Acme Corp,T-1,100.00,0,0,check,standard,Jane,Doe,Robotics team",
      "D-1,2026-09-01,Acme Corp,T-2,20.00,0,0,check,standard,John,Smith,Chess club",
      "D-2,2026-09-01,Acme Corp,T-3,10.00,0,0,check,standard,Ann,Lee,Robotics team",
    ]);

    expect(await db.disbursementEvent.count({ where: { orgId } })).toBe(0);
    expect(await db.disbursementSnapshot.count({ where: { orgId, disbursementId: "D-1" } })).toBe(0);
    const d2 = await db.disbursementSnapshot.findFirstOrThrow({ where: { orgId, disbursementId: "D-2" } });
    expect(d2.state).toBe("on_hold");
    expect(await getNavCounts(orgId)).toEqual({ unassignedQueue: 1, disbursementHolds: 1 });

    await makeAccountMapRule(orgId);
    const t2 = await db.transaction.findFirstOrThrow({ where: { orgId, transactionId: "T-2" } });
    await transactionService.assignOwner(orgId, t2.id, 201, false, AUDIT);
    await db.disbursementEvent.findFirstOrThrow({ where: { orgId, disbursementId: "D-1" } });
  });
});

describeDb("donor data reads are audited", () => {
  it("each pii read writes one DONOR_DATA_READ row with route and count", async () => {
    await upload(FILE);
    const rows = await transactionService.listUnassignedTransactions(orgId, READER);
    expect(rows).toHaveLength(2);
    const t1 = await transactionService.getTransaction(orgId, rows[0].id, READER);
    expect(t1?.donorFirstName).toBe("Jane");
    await transactionService.listTransactions(orgId, READER);
    await commentRuleService.listCommentRules(orgId, { ...READER, route: "/api/donations/comment-rules" });

    const reads = await db.workflowEvent.findMany({ where: { orgId, eventType: "DONOR_DATA_READ" }, orderBy: { id: "asc" } });
    expect(reads.map((r) => JSON.parse(r.payload!))).toEqual([
      { route: READER.route, filter: { unassigned: true }, count: 2 },
      { route: READER.route, ids: [rows[0].id], count: 1 },
      { route: READER.route, filter: { assigned: null }, count: 3 },
      { route: "/api/donations/comment-rules", count: 0 },
    ]);
    expect(reads.every((r) => r.actorUserId === 1)).toBe(true);
  });

  it("no workflow event payload carries a donor field", async () => {
    await makeAccountMapRule(orgId);
    await upload(FILE);
    const t1 = await db.transaction.findFirstOrThrow({ where: { orgId, transactionId: "T-1" } });
    await transactionService.assignOwner(orgId, t1.id, 201, true, AUDIT);
    await transactionService.listTransactions(orgId, READER);

    const payloads = (await db.workflowEvent.findMany({ where: { orgId } })).map((e) => e.payload ?? "");
    expect(payloads.length).toBeGreaterThan(0);
    for (const p of payloads) for (const f of DONOR_FIELDS) expect(p).not.toContain(f);
  });
});

describeDb("QuickBooks match pre-seat", () => {
  const event = (disbursementId: string, date: string, qbMatchState: string, qbTxnId: string | null) =>
    db.disbursementEvent.create({
      data: {
        orgId,
        disbursementId,
        qbMatchState,
        qbTxnId,
        payload: JSON.stringify({ version: 1, orgId, disbursementId, disbursementDate: date, disbursementFrom: null, items: [] }),
      },
    });

  it("a QuickBooks entry is claimed at most once per org", async () => {
    await event("D-A", "2026-09-01", QB_MATCH_STATE.MATCHED, "qb-1");
    await expect(event("D-B", "2026-09-02", QB_MATCH_STATE.MATCHED, "qb-1")).rejects.toMatchObject({ code: "P2002" });
    await event("D-C", "2026-09-03", QB_MATCH_STATE.UNMATCHED, null);
    await event("D-D", "2026-09-04", QB_MATCH_STATE.UNMATCHED, null);
  });

  it("an exclusion is unique per org", async () => {
    const data = { orgId, qbTxnId: "qb-9", reason: "hand-booked grant", excludedByUserId: 1 };
    await db.donationQbMatchExclusion.create({ data });
    await expect(db.donationQbMatchExclusion.create({ data })).rejects.toMatchObject({ code: "P2002" });
  });

  it("the Benevity takeover line is the newest matched disbursement date; CREATED never sets it", async () => {
    expect(await benevityTakeoverLine(db, orgId)).toBeNull();
    await event("D-A", "2026-08-01", QB_MATCH_STATE.MATCHED, "qb-1");
    await recordQbMatched(db, orgId, { disbursementId: "D-A", disbursementDate: "2026-08-01", qbTxnId: "qb-1" }, AUDIT);
    await event("D-B", "2026-09-01", QB_MATCH_STATE.CREATED, "qb-2");
    expect(await benevityTakeoverLine(db, orgId)).toBe("2026-08-01");
  });

  it("un-matching the newest matched record does not move the line back", async () => {
    await event("D-A", "2026-08-01", QB_MATCH_STATE.MATCHED, "qb-1");
    await recordQbMatched(db, orgId, { disbursementId: "D-A", disbursementDate: "2026-08-01", qbTxnId: "qb-1" }, AUDIT);
    await event("D-B", "2026-09-01", QB_MATCH_STATE.MATCHED, "qb-2");
    await recordQbMatched(db, orgId, { disbursementId: "D-B", disbursementDate: "2026-09-01", qbTxnId: "qb-2" }, AUDIT);
    expect(await benevityTakeoverLine(db, orgId)).toBe("2026-09-01");

    await db.disbursementEvent.updateMany({
      where: { orgId, disbursementId: "D-B" },
      data: { qbMatchState: QB_MATCH_STATE.UNMATCHED, qbTxnId: null },
    });
    expect(await benevityTakeoverLine(db, orgId)).toBe("2026-09-01");
  });
});
