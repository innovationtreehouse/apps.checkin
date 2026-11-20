import { createHash } from "node:crypto";
import { KindedError } from "@checkin/component-kit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, getPrisma } from "../../db";
import type { MailAgingOutEvent, MailboxReader, MailHoldCeilingEvent, MailMessage, MailPart } from "../../contract";
import { MAX_FILE_BYTES } from "../../lib/file-type";
import {
  MAIL_CAP,
  MAIL_HELD_BYTES,
  MAIL_HELD_CAP,
  MAIL_HELD_CEILING,
  MAIL_TIME_BUDGET_MS,
  MAIL_WINDOW_DAYS,
  INLINE_FLOOR_BYTES,
  MAIL_CATCH_UP_CAP,
  mailRunState,
  readMailbox,
  startMailRun,
} from "../../services/mailIntake";
import { createMemoryFileStore } from "../../lib/fileStorage";
import { fileStore } from "../../runtime";
import { createGmailReader } from "../../lib/gmail";
import { mailQueueService } from "../../services/mailQueueService";
import { OCR_INTERRUPTED_AFTER_MS, sweepInterruptedOcr } from "../../services/catchUp";
import { DRAIN_BUDGET_MS } from "../../services/ocrDrain";
import { describeDb } from "../helpers/db";
import { toRaw } from "../helpers/mime";
import type { ReceiptLimits } from "../../lib/limits";
import { receiptService } from "../../services/receiptService";
import { actAs, ALICE, BOB, clearAll, configure, FINANCE, manualDetails, okOcr, stateOf, storedBytes, storeFile, TEST_ORG_ID, textFile, uploadRead } from "../helpers/setup";

const GOOGLE_PASS = "mx.google.com; dkim=pass header.i=@example.org; spf=pass; dmarc=pass (p=NONE sp=NONE) header.from=example.org";
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const pdf = (label: string) => `%PDF-1.4 receipt ${label}`;
/** Over the body size floor on its own, with no amount in it. */
const PAD = "Thank you for shopping with us. Please keep this email for your records; it is your proof of purchase.";
/** A text receipt long enough to be read. */
const textReceipt = (line: string) => `${line}\n${PAD}`;

/** A fake Gmail mailbox: messages by id, written out raw when fetched, and attachment contents by id. */
function fakeMailbox() {
  const messages = new Map<string, MailMessage>();
  const attachments = new Map<string, string>();
  const reader: MailboxReader = {
    address: "receipts@example.org",
    listRecent: async (days) => [...messages.values()].filter((m) => Number(m.internalDate) > Date.now() - days * DAY_MS).map((m) => m.id),
    getRaw: async (id) => {
      const msg = messages.get(id);
      if (!msg) throw new Error(`no message ${id}`);
      return { raw: toRaw(msg, attachments), internalDate: msg.internalDate };
    },
  };
  return { messages, attachments, reader };
}

let mail: ReturnType<typeof fakeMailbox>;
let alerts: MailHoldCeilingEvent[];
let agingAlerts: MailAgingOutEvent[];
const DAY_MS = 24 * 60 * 60_000;

const attachment = (id: string, content: string, over: Partial<MailPart> = {}): MailPart => {
  mail.attachments.set(id, content);
  return { mimeType: "application/pdf", filename: `${id}.pdf`, body: { attachmentId: id, size: content.length }, ...over };
};

/** A message; `auth` lists its Authentication-Results headers top first, `from` its From headers, `ageMs` how long ago it arrived. */
function send(
  id: string,
  {
    from = ["Alice <alice@example.org>"],
    auth = [GOOGLE_PASS],
    parts,
    ageMs = 0,
  }: { from?: string[]; auth?: string[]; parts?: MailPart[]; ageMs?: number } = {},
): void {
  mail.messages.set(id, {
    id,
    internalDate: String(Date.now() - ageMs),
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        ...auth.map((value) => ({ name: "Authentication-Results", value })),
        ...from.map((value) => ({ name: "From", value })),
      ],
      parts: parts ?? [{ mimeType: "text/plain", body: { data: b64("see attached") } }, attachment(`att-${id}`, pdf(id))],
    },
  });
}

const testAlerts = () => ({
  mailHoldCeilingReached: async (event: MailHoldCeilingEvent) => void alerts.push(event),
  mailAgingOut: async (event: MailAgingOutEvent) => void agingAlerts.push(event),
});

beforeEach(async () => {
  await clearAll();
  mail = fakeMailbox();
  alerts = [];
  agingAlerts = [];
  configure({
    ocr: okOcr(),
    mailbox: mail.reader,
    alerts: testAlerts(),
    people: { submitterByEmail: async (address) => (address === "alice@example.org" ? ALICE : null) },
  });
});

describeDb("mail intake", () => {
  it("turns a new message from a known sender into one receipt by that sender", async () => {
    send("m1");
    expect(await readMailbox()).toMatchObject({ status: "ok", receipts: 1, held: 0 });

    const [receipt] = await db.receipt.findMany();
    expect(receipt).toMatchObject({ intakeSource: "email", uploadedByUserId: ALICE.id, mimeType: "application/pdf" });
    expect(await storedBytes(receipt.fileKey)).toBe(pdf("m1"));
    expect(await stateOf(receipt.id)).toBe("submitter_review");
    const [item] = await db.receiptMailItem.findMany();
    expect(item).toMatchObject({ status: "assigned", receiptId: receipt.id, senderAddress: "alice@example.org", fileBlob: null });
  });

  it("creates nothing on a re-read", async () => {
    send("m1");
    await readMailbox();
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 0, skipped: 1 });
    expect(await db.receipt.count()).toBe(1);
    expect(await db.receiptMailItem.count()).toBe(1);
  });

  it("holds a message from an unknown sender for finance, with its file", async () => {
    send("m1", { from: ["stranger@example.org"] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 1 });
    expect(await db.receipt.count()).toBe(0);
    const [item] = await db.receiptMailItem.findMany();
    expect(item).toMatchObject({ status: "held", holdReason: "not_a_submitter", senderAddress: "stranger@example.org", mimeType: "application/pdf", receiptId: null, heldAt: expect.any(Date) });
    expect(await storedBytes(item.fileKey)).toBe(pdf("m1"));
  });

  it("does nothing when no mailbox is bound", async () => {
    configure({ ocr: okOcr() });
    send("m1");
    expect(await readMailbox()).toEqual({ status: "unbound" });
    expect(await db.receiptMailItem.count()).toBe(0);
  });

  it("takes a body holding a money amount as a receipt, storing HTML as text", async () => {
    const plain = textReceipt("Order 42 total $5.00");
    const html = `<p>Order 43 total 7.50</p><p>${PAD}</p>`;
    send("plain", { parts: [{ mimeType: "text/plain", body: { data: b64(plain) } }] });
    send("html", { parts: [{ mimeType: "text/html", body: { data: b64(html) } }] });
    expect(await readMailbox()).toMatchObject({ receipts: 2, ignored: 0 });
    const files = await Promise.all((await db.receipt.findMany()).map(async (r) => [r.mimeType, await storedBytes(r.fileKey)]));
    expect(files).toEqual(expect.arrayContaining([["text/plain", plain], ["text/plain", html]]));
  });

  it("skips a body under the size floor and counts it ignored", async () => {
    send("m1", { parts: [{ mimeType: "text/plain", body: { data: b64("For the lathe, total $5") } }] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 0, ignored: 1 });
    expect(await db.receiptMailItem.count()).toBe(0);
  });

  it("holds an unknown sender's long body with no amount for finance", async () => {
    send("m1", { from: ["stranger@example.org"], parts: [{ mimeType: "text/plain", body: { data: b64(PAD) } }] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 1 });
    const [item] = await db.receiptMailItem.findMany();
    expect(item).toMatchObject({ status: "held", holdReason: "not_a_submitter", mimeType: "text/plain" });
    expect(await storedBytes(item.fileKey)).toBe(PAD);
  });

  it("holds an unverified sender's long body with no amount for finance", async () => {
    send("m1", { auth: [], parts: [{ mimeType: "text/plain", body: { data: b64(PAD) } }] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 1 });
    expect(await db.receiptMailItem.findFirstOrThrow()).toMatchObject({ status: "held", holdReason: "unverified_sender" });
  });

  it("holds one file-less note naming each file refused from an unknown sender, once", async () => {
    const docx = { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "invoice.docx", body: { data: b64("PK"), size: 2 } };
    const eml = { mimeType: "message/rfc822", filename: "receipt.eml", parts: [{ mimeType: "text/plain", body: { data: b64("Order total 12.00") } }] };
    send("m1", { from: ["stranger@example.org"], parts: [{ mimeType: "text/plain", body: { data: b64("see attached") } }, docx, eml] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 1 });
    expect(await db.receiptMailItem.findMany()).toEqual([
      expect.objectContaining({
        status: "held",
        holdReason: "not_a_submitter",
        senderAddress: "stranger@example.org",
        fileBlob: null,
        fileKey: null,
        mimeType: null,
        refusal: [{ file: "invoice.docx", reason: "wrong_type" }, { file: "receipt.eml", reason: "forwarded" }],
      }),
    ]);

    await db.receiptMailAtRisk.create({ data: { orgId: TEST_ORG_ID, gmailMessageId: "m1", receivedAt: new Date() } });
    expect(await readMailbox()).toMatchObject({ held: 0 });
    expect(await db.receiptMailItem.count()).toBe(1);
  });

  it("holds a refused file beside an unknown sender's held file, and holds neither twice", async () => {
    const bad = { mimeType: "application/pdf", filename: "scan.pdf", body: { data: b64("not a pdf"), size: 9 } };
    send("m1", { from: ["stranger@example.org"], parts: [attachment("a", pdf("a")), bad] });
    expect(await readMailbox()).toMatchObject({ held: 2 });
    await db.receiptMailAtRisk.create({ data: { orgId: TEST_ORG_ID, gmailMessageId: "m1", receivedAt: new Date() } });
    expect(await readMailbox()).toMatchObject({ held: 0 });
    const items = await db.receiptMailItem.findMany({ orderBy: { id: "asc" }, select: { mimeType: true, refusal: true } });
    expect(items).toEqual([{ mimeType: "application/pdf", refusal: null }, { mimeType: null, refusal: [{ file: "scan.pdf", reason: "wrong_type" }] }]);
  });

  it("still reads a put-off file once finance discards its message's refusal note", async () => {
    const fit = Math.floor(MAIL_HELD_BYTES / MAX_FILE_BYTES);
    for (let i = 0; i < fit; i++) send(`big${i}`, { from: [`big${i}@example.org`], parts: [attachment(`att-big${i}`, pdf(`big${i}`), { body: { attachmentId: `att-big${i}`, size: MAX_FILE_BYTES } })] });
    const doc = { mimeType: "application/msword", filename: "r.doc", body: { data: b64("PK"), size: 2 } };
    send("m1", { from: ["stranger@example.org"], parts: [attachment("a", pdf("a")), doc] });
    expect(await readMailbox()).toMatchObject({ held: fit + 1, deferred: 1 });
    const note = await db.receiptMailItem.findFirstOrThrow({ where: { gmailMessageId: "m1" } });
    expect(note).toMatchObject({ mimeType: null, refusal: [{ file: "r.doc", reason: "wrong_type" }] });
    await db.receiptMailItem.update({ where: { id: note.id }, data: { status: "discarded" } });

    expect(await readMailbox()).toMatchObject({ held: 1 });
    expect(await db.receiptMailItem.findMany({ where: { gmailMessageId: "m1" }, orderBy: { id: "asc" }, select: { status: true, mimeType: true } })).toEqual([
      { status: "discarded", mimeType: null },
      { status: "held", mimeType: "application/pdf" },
    ]);
  });

  it("holds an unverified sender's refused file, and none of a submitter's", async () => {
    const docx = { mimeType: "application/msword", filename: "r.doc", body: { data: b64("PK"), size: 2 } };
    send("forged", { auth: [], parts: [docx] });
    send("alice", { parts: [docx] });
    await readMailbox();
    expect(await db.receiptMailItem.findMany({ select: { gmailMessageId: true, holdReason: true, refusal: true } })).toEqual([
      { gmailMessageId: "forged", holdReason: "unverified_sender", refusal: [{ file: "r.doc", reason: "wrong_type" }] },
    ]);
  });

  it("stores no item for a submitter's long body with no amount", async () => {
    send("m1", { parts: [{ mimeType: "text/plain", body: { data: b64(PAD) } }] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 0 });
    expect(await db.receiptMailItem.count()).toBe(0);
  });

  /** The message's receipts in ledger order, as [mimeType, state]. */
  const messageReceipts = async () => {
    const items = await db.receiptMailItem.findMany({ orderBy: { id: "asc" }, select: { receiptId: true } });
    return Promise.all(
      items.map(async (i) => {
        const r = await db.receipt.findUniqueOrThrow({ where: { id: i.receiptId ?? "" } });
        return [r.id, r.mimeType, await stateOf(r.id)];
      }),
    );
  };

  it("reads a body after the attachments, and discards it when its reading repeats one", async () => {
    send("m1", { parts: [{ mimeType: "text/plain", body: { data: b64(textReceipt("Order total 5.00")) } }, attachment("a", pdf("a"))] });
    expect(await readMailbox()).toMatchObject({ receipts: 2 });
    const [[pdfId, pdfType], [bodyId, bodyType, bodyState]] = await messageReceipts();
    expect([pdfType, bodyType, bodyState]).toEqual(["application/pdf", "text/plain", "discarded"]);
    expect(await stateOf(pdfId as string)).not.toBe("discarded");
    expect(await db.receiptAuditLog.findFirst({ where: { receiptId: bodyId as string, action: "body_copy_discarded" } })).toMatchObject({
      userId: null,
      valueAfter: `same as attachment ${pdfId}`,
    });
    actAs(ALICE);
    await receiptService.submitterConfirm(pdfId as string);
    expect(await stateOf(pdfId as string)).not.toBe("duplicate_flagged");
  });

  it("keeps a body whose reading differs from every attachment's", async () => {
    configure({
      ocr: { extract: (file, mimeType) => okOcr(mimeType === "text/plain" ? { receiptTotal: 9 } : {}).extract(file, mimeType) },
      mailbox: mail.reader,
      people: { submitterByEmail: async (address) => (address === "alice@example.org" ? ALICE : null) },
    });
    send("m1", { parts: [{ mimeType: "text/plain", body: { data: b64(textReceipt("Order total 9.00")) } }, attachment("a", pdf("a"))] });
    expect(await readMailbox()).toMatchObject({ receipts: 2 });
    expect((await messageReceipts()).map(([, , state]) => state)).not.toContain("discarded");
  });

  it("reads inline images of an accepted type, skips those under the floor, and skips unaccepted types", async () => {
    const gif = (n: number) => "GIF89a".padEnd(n, "x");
    const inline = [{ name: "Content-Disposition", value: "inline" }];
    send("m1", {
      parts: [
        { mimeType: "text/plain", body: { data: b64("see photos") } },
        attachment("a", pdf("a")),
        attachment("photo", gif(INLINE_FLOOR_BYTES), { mimeType: "image/gif", filename: "photo.gif", headers: inline }),
        attachment("pasted", gif(INLINE_FLOOR_BYTES + 1), { mimeType: "image/gif", filename: undefined }),
        attachment("logo", gif(16), { mimeType: "image/gif", filename: "logo.png", headers: inline }),
        attachment("doc", "PK", { mimeType: "application/zip", filename: "x.zip" }),
      ],
    });
    expect(await readMailbox()).toMatchObject({ receipts: 3, ignored: 2 });
  });

  it("skips a file on the org's ignore list, charges it like a rejected one, and ledgers it as discarded", async () => {
    const logo = pdf("logo");
    await db.receiptIgnoredFile.create({
      data: { orgId: TEST_ORG_ID, fileHash: createHash("sha256").update(logo).digest("hex"), reason: "newsletter logo", addedByUserId: 1 },
    });
    for (let i = 0; i < MAIL_HELD_CAP + 1; i++) send(`n${i}`, { from: [`news${i}@example.org`], parts: [attachment(`att-n${i}`, logo)] });
    send("member", { parts: [attachment("logo-from-alice", logo), attachment("real", pdf("real"))] });
    expect(await readMailbox()).toMatchObject({ receipts: 1, held: 0, ignored: MAIL_HELD_CAP + 1, deferred: 1 });
    expect(await db.receiptMailItem.count({ where: { status: "discarded", fileBlob: null } })).toBe(MAIL_HELD_CAP + 1);

    const fetched = trackFetches();
    expect(await readMailbox()).toMatchObject({ messages: 1, receipts: 0, ignored: 1, skipped: MAIL_HELD_CAP + 2 });
    expect(fetched).toEqual([]);
  });

  it("refuses a file whose content does not match its type", async () => {
    send("m1", { parts: [attachment("fake", "not a pdf")] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 0, rejected: 1 });
  });

  it("stops at the per-run cap, oldest mail first, and takes the rest next run", async () => {
    configure({ ocr: okOcr(), mailbox: mail.reader, people: { submitterByEmail: async () => ({ ...ALICE, raisedMailLimit: true }) } });
    for (let i = 0; i <= MAIL_CAP; i++) send(`m${i}`);
    expect(await readMailbox()).toMatchObject({ receipts: MAIL_CAP });
    const read = (await db.receiptMailItem.findMany()).map((m) => m.gmailMessageId);
    expect(read).toContain("m0");
    expect(read).not.toContain(`m${MAIL_CAP}`);
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
  });

  it("holds any number of untrusted messages without starving a member's receipt", async () => {
    for (let i = 0; i < MAIL_CAP; i++) send(`spam${i}`, { from: [`stranger${i}@example.org`] });
    send("member");
    for (let i = 0; i < MAIL_CAP; i++) send(`later${i}`, { from: [`other${i}@example.org`] });
    expect(await readMailbox()).toMatchObject({ receipts: 1, held: 2 * MAIL_CAP });
    expect((await db.receipt.findFirstOrThrow()).uploadedByUserId).toBe(ALICE.id);
  });
});

describeDb("mail intake catch-up", () => {
  const hold = (until: Date) => db.receiptMailLease.create({ data: { orgId: TEST_ORG_ID, until } });
  const runEnds = () => vi.waitFor(async () => expect((await mailRunState()).running).toBe(false), { timeout: 10_000 });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads past the cron's cap, records its counts and audits who started it", async () => {
    configure({ ocr: okOcr(), mailbox: mail.reader, people: { submitterByEmail: async () => ({ ...ALICE, raisedMailLimit: true }) } });
    expect(MAIL_CATCH_UP_CAP).toBeGreaterThan(MAIL_CAP);
    for (let i = 0; i <= MAIL_CAP; i++) send(`m${i}`);
    actAs(FINANCE);
    expect(await mailQueueService.catchUp()).toMatchObject({ status: "started" });
    await runEnds();
    const state = await mailQueueService.catchUpState();
    expect(state).toMatchObject({ status: "idle", lastRun: { status: "ok", messages: MAIL_CAP + 1, receipts: MAIL_CAP + 1, held: 0, waiting: 0, more: false } });
    expect(state.lastRunAt).toBeInstanceOf(Date);
    expect(await db.receiptAuditLog.findFirst({ where: { action: "mail_catch_up_started" } })).toMatchObject({ receiptId: null, userId: FINANCE.id });
  });

  it("writes the catch-up audit row before the run reads mail", async () => {
    send("m1");
    const audit = vi.spyOn(getPrisma().receiptAuditLog, "create");
    const listing = vi.spyOn(mail.reader, "listRecent");
    actAs(FINANCE);
    expect(await mailQueueService.catchUp()).toMatchObject({ status: "started" });
    await runEnds();
    expect(audit.mock.calls[0][0]).toMatchObject({ data: { action: "mail_catch_up_started" } });
    expect(listing).toHaveBeenCalledOnce();
    expect(audit.mock.invocationCallOrder[0]).toBeLessThan(listing.mock.invocationCallOrder[0]);
  });

  it("starts no run and frees the lease when the catch-up audit write fails", async () => {
    send("m1");
    vi.spyOn(getPrisma().receiptAuditLog, "create").mockRejectedValueOnce(new Error("audit write failed"));
    const listing = vi.spyOn(mail.reader, "listRecent");
    actAs(FINANCE);
    await expect(mailQueueService.catchUp()).rejects.toThrow("audit write failed");
    expect(listing).not.toHaveBeenCalled();
    expect(await mailRunState()).toMatchObject({ running: false, lastRunAt: null });
    expect(await db.receiptMailItem.count()).toBe(0);
    expect(await readMailbox()).toMatchObject({ status: "ok" });
  });

  it("says another run would read more when the cap stopped it", async () => {
    configure({ ocr: okOcr(), mailbox: mail.reader, people: { submitterByEmail: async () => ({ ...ALICE, raisedMailLimit: true }) } });
    for (let i = 0; i <= MAIL_CAP; i++) send(`m${i}`);
    await readMailbox();
    expect((await mailRunState()).lastRun).toMatchObject({ receipts: MAIL_CAP, waiting: 1, more: true });
  });

  it("refuses the cron and the button while another run holds the lease, reading nothing", async () => {
    send("m1");
    await hold(new Date(Date.now() + 60_000));
    expect(await readMailbox()).toEqual({ status: "busy" });
    actAs(FINANCE);
    expect(await mailQueueService.catchUp()).toMatchObject({ status: "busy" });
    expect(await mailQueueService.catchUpState()).toMatchObject({ status: "running" });
    expect(await db.receiptMailItem.count()).toBe(0);
    expect(await db.receiptAuditLog.count({ where: { action: "mail_catch_up_started" } })).toBe(0);
  });

  it("lets one of three simultaneous starts run", async () => {
    send("m1");
    const runs = await Promise.all([startMailRun(), startMailRun(), startMailRun()]);
    expect(runs.map((r) => r.status).sort()).toEqual(["busy", "busy", "started"]);
    for (const run of runs) if (run.status === "started") await run.done;
    expect(await db.receiptMailItem.count()).toBe(1);
  });

  it("takes a lease a crashed run left past its expiry", async () => {
    send("m1");
    await hold(new Date(Date.now() - 1000));
    expect(await readMailbox()).toMatchObject({ status: "ok", receipts: 1 });
    expect((await mailRunState()).running).toBe(false);
  });

  it("refuses a catch-up with no mailbox set up", async () => {
    configure({ ocr: okOcr() });
    actAs(FINANCE);
    await expect(mailQueueService.catchUp()).rejects.toMatchObject({ status: 409 });
  });
});

describeDb("mail intake flood limits", () => {
  const stranger = (id: string, over: Partial<MailPart> = {}) =>
    send(id, { from: [`${id}@example.org`], parts: [attachment(`att-${id}`, pdf(id), over)] });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("neither fetches nor processes a message already processed", async () => {
    send("m1");
    await readMailbox();
    const fetched = trackFetches();
    expect(await readMailbox()).toMatchObject({ messages: 0, receipts: 0, skipped: 1 });
    expect(fetched).toEqual([]);
  });

  it("holds at most MAIL_HELD_CAP files per run, and counts the rest", async () => {
    for (let i = 0; i < MAIL_HELD_CAP + 2; i++) stranger(`s${i}`);
    send("member");
    expect(await readMailbox()).toMatchObject({ receipts: 1, held: MAIL_HELD_CAP, deferred: 2 });
    expect(await readMailbox()).toMatchObject({ held: 2, deferred: 0 });
  });

  it("stops holding at the per-run byte budget", async () => {
    const fit = Math.floor(MAIL_HELD_BYTES / MAX_FILE_BYTES);
    for (let i = 0; i <= fit; i++) stranger(`s${i}`, { body: { attachmentId: `att-s${i}`, size: MAX_FILE_BYTES } });
    expect(await readMailbox()).toMatchObject({ held: fit, deferred: 1 });
  });

  it("charges an unknown sender's rejected files and refusal notes to the held budget, so junk cannot crowd out a receipt", async () => {
    for (let i = 0; i < MAIL_HELD_CAP + 5; i++) send(`junk${i}`, { from: [`junk${i}@example.org`], parts: [attachment(`att-junk${i}`, "not a pdf")] });
    send("member");
    const half = MAIL_HELD_CAP / 2;
    expect(await readMailbox()).toMatchObject({ receipts: 1, held: half, rejected: half, deferred: MAIL_HELD_CAP + 5 - half });
    expect(await db.receiptMailItem.count({ where: { status: "held", fileBlob: null, fileKey: null } })).toBe(half);
  });

  it("charges each refusal note one held file", async () => {
    const doc = (i: number) => ({ mimeType: "application/msword", filename: `r${i}.doc`, body: { data: b64("PK"), size: 2 } });
    for (let i = 0; i < MAIL_HELD_CAP + 3; i++) send(`doc${i}`, { from: [`doc${i}@example.org`], parts: [doc(i), doc(i + 1000)] });
    expect(await readMailbox()).toMatchObject({ held: MAIL_HELD_CAP, deferred: 3 });
  });

  it("charges a rejected file's stated size to the byte budget", async () => {
    const fit = Math.floor(MAIL_HELD_BYTES / MAX_FILE_BYTES);
    for (let i = 0; i <= fit; i++) {
      send(`junk${i}`, { from: [`junk${i}@example.org`], parts: [attachment(`att-junk${i}`, "not a pdf", { body: { attachmentId: `att-junk${i}`, size: MAX_FILE_BYTES } })] });
    }
    expect(await readMailbox()).toMatchObject({ rejected: fit, deferred: 1 });
  });

  it("past the held ceiling, holds nothing new, alerts finance, and still reads receipts", async () => {
    await db.receiptMailItem.createMany({
      data: Array.from({ length: MAIL_HELD_CEILING }, (_, i) => ({
        orgId: TEST_ORG_ID,
        gmailMessageId: `old${i}`,
        attachmentHash: `h${i}`,
        receivedAt: new Date(),
        senderAddress: "old@example.org",
      })),
    });
    stranger("s1");
    send("member");
    expect(await readMailbox()).toMatchObject({ receipts: 1, held: 0, overCeiling: 1 });
    expect(alerts).toEqual([{ orgId: TEST_ORG_ID, unresolved: MAIL_HELD_CEILING, refused: 1 }]);
  });

  it("past the held ceiling, holds no refusal note, and reads the message again later", async () => {
    await db.receiptMailItem.createMany({
      data: Array.from({ length: MAIL_HELD_CEILING }, (_, i) => ({ orgId: TEST_ORG_ID, gmailMessageId: `old${i}`, attachmentHash: `h${i}`, receivedAt: new Date(), senderAddress: "old@example.org" })),
    });
    send("s1", { from: ["stranger@example.org"], parts: [{ mimeType: "application/msword", filename: "r.doc", body: { data: b64("PK"), size: 2 } }] });
    expect(await readMailbox()).toMatchObject({ held: 0, overCeiling: 1 });
    expect(await db.receiptMailItem.count({ where: { gmailMessageId: "s1" } })).toBe(0);
    expect(await db.receiptMailMessage.findFirstOrThrow({ where: { gmailMessageId: "s1" } })).toMatchObject({ processedAt: null, processError: null });
  });

  it("refuses an attachment over the upload size limit", async () => {
    send("m1", { parts: [attachment("big", pdf("big"), { body: { attachmentId: "big", size: MAX_FILE_BYTES + 1 } })] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 0, rejected: 1 });
  });

  it("stops at the time budget and leaves the rest for the next run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    send("m1");
    send("m2");
    const spent = spendBudgetOnFirstCapture();
    // m1 is captured, m2 is not reached, and nothing is left to process m1.
    expect(await readMailbox()).toMatchObject({ captured: 1, messages: 0, receipts: 0, unread: 2 });
    expect(agingAlerts).toEqual([]);
    spent.mockRestore();
    expect(await readMailbox()).toMatchObject({ captured: 1, messages: 2, receipts: 2, unread: 0 });
  });
});

/** A call that never answers, after moving the clock past the run's capture deadline but not its end-of-run calls'. */
const hangPastReadingDeadline = (): Promise<never> => {
  vi.setSystemTime(Date.now() + MAIL_TIME_BUDGET_MS + 1_000);
  return new Promise(() => {});
};

/** A reading that never answers, after moving the clock past the drain's deadline but not the lease's. */
const hangPastDrainDeadline = (): Promise<never> => {
  vi.setSystemTime(Date.now() + DRAIN_BUDGET_MS + 60_000);
  return new Promise(() => {});
};

describeDb("mail intake call deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("abandons a hung reading in the drain at its deadline, releases the lease, and leaves the receipt for the sweep", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    send("m1");
    send("m2");
    const sent: string[] = [];
    configure({
      ocr: { extract: hangPastDrainDeadline },
      mailbox: mail.reader,
      alerts: testAlerts(),
      people: { submitterByEmail: async () => ALICE },
      replies: {
        contactOf: async () => ({ email: "alice@example.org", name: "Alice" }),
        send: async (ack) => {
          sent.push(ack.to);
          return true;
        },
      },
    });

    expect(await readMailbox()).toMatchObject({ status: "ok", messages: 2, receipts: 2, unread: 0, replied: 2 });
    expect(sent).toEqual(["alice@example.org", "alice@example.org"]);
    expect(await mailRunState()).toMatchObject({ running: false, lastRun: { status: "ok", drain: { read: 0, failed: 1, waiting: 1 } } });
    const states = await db.receiptDetail.findMany({ select: { id: true, state: true }, orderBy: [{ ocrQueuedAt: "asc" }, { id: "asc" }] });
    expect(states.map((r) => r.state)).toEqual(["auto_upload", "ocr_queued"]);
    await sweepInterruptedOcr(new Date(Date.now() + OCR_INTERRUPTED_AFTER_MS + 1));
    expect(await stateOf(states[0].id)).toBe("ocr_failed");
  });

  it("ends the run as a listing failure when a mailbox fetch hangs, and releases the lease", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    send("m1");
    send("m2");
    mail.reader.getRaw = hangPastReadingDeadline;

    expect(await readMailbox()).toMatchObject({ status: "listing_failed", captured: 0, messages: 0, failed: 1, unread: 1, receipts: 0 });
    expect((await mailRunState()).running).toBe(false);
    expect(await db.receipt.count()).toBe(0);
  });

  it("after a hung fetch, clears the messages captured and stores the rest as at risk", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    send("m1", { ageMs: 3 * 60_000 });
    send("m2", { ageMs: 2 * 60_000 });
    send("m3", { ageMs: 60_000 });
    const { getRaw } = mail.reader;
    let hung = false;
    // The clock moves before byDeadline arms its timer, so only the first fetch of m2 hangs.
    mail.reader.getRaw = (id) => (id === "m2" && !hung ? ((hung = true), hangPastReadingDeadline()) : getRaw(id));

    // m3 is not reached; m1 is captured, with no time left to process it.
    expect(await readMailbox()).toMatchObject({ status: "listing_failed", captured: 1, messages: 0, receipts: 0, failed: 1, unread: 2 });
    const atRisk = await db.receiptMailAtRisk.findMany({ orderBy: { gmailMessageId: "asc" } });
    expect(atRisk.map((r) => r.gmailMessageId)).toEqual(["m2", "m3"]);
    expect(atRisk[1].receivedAt).not.toBeNull();
  });

  it("counts a hung acknowledgement as failed, releases the lease, and never sends it again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    send("m1");
    const sent: string[] = [];
    let hang = true;
    configure({
      ocr: okOcr(),
      mailbox: mail.reader,
      alerts: testAlerts(),
      people: { submitterByEmail: async () => ALICE },
      replies: {
        contactOf: async () => ({ email: "alice@example.org", name: "Alice" }),
        send: async (ack) => {
          if (hang) {
            // Past the run's end-of-run deadline, short of its lease.
            vi.setSystemTime(Date.now() + MAIL_TIME_BUDGET_MS + DRAIN_BUDGET_MS + 9.5 * 60_000);
            return new Promise<boolean>(() => {});
          }
          sent.push(ack.to);
          return true;
        },
      },
    });

    expect(await readMailbox()).toMatchObject({ status: "ok", receipts: 1, replied: 0, replyFailed: 1 });
    expect((await mailRunState()).running).toBe(false);
    hang = false;
    expect(await readMailbox()).toMatchObject({ replied: 0, replyFailed: 0 });
    expect(sent).toEqual([]);
    expect((await db.receiptMailReply.findFirstOrThrow()).claimedAt).not.toBeNull();
  });
});

/** Moves the clock past the run's budget once the first raw copy is stored, so that copy is kept and nothing after it starts. */
function spendBudgetOnFirstCapture() {
  const store = fileStore();
  const put = store.put;
  let first = true;
  return vi.spyOn(store, "put").mockImplementation(async (key, bytes, sha) => {
    await put(key, bytes, sha);
    if (first && key.startsWith("mail-raw/")) {
      first = false;
      vi.setSystemTime(Date.now() + MAIL_TIME_BUDGET_MS);
    }
  });
}

/** Records the ids each run fetches. */
function trackFetches(): string[] {
  const fetched: string[] = [];
  const { getRaw } = mail.reader;
  mail.reader.getRaw = async (id) => {
    fetched.push(id);
    return getRaw(id);
  };
  return fetched;
}

describeDb("mail intake re-reads", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fetch a message whose files were all read or held", async () => {
    send("member");
    send("stranger", { from: ["stranger@example.org"] });
    expect(await readMailbox()).toMatchObject({ receipts: 1, held: 1 });
    const fetched = trackFetches();
    expect(await readMailbox()).toMatchObject({ messages: 0, receipts: 0, held: 0, skipped: 2 });
    expect(fetched).toEqual([]);
  });

  it("processes a partly read message again from its stored copy, without fetching it", async () => {
    configure({ ocr: okOcr(), mailbox: mail.reader, alerts: testAlerts(), people: { submitterByEmail: async () => ({ ...ALICE, raisedMailLimit: true }) } });
    for (let i = 0; i < MAIL_CAP - 1; i++) send(`m${i}`);
    send("two", { parts: [attachment("a", pdf("a")), attachment("b", pdf("b"))] });
    expect(await readMailbox()).toMatchObject({ receipts: MAIL_CAP, deferred: 1 });
    const fetched = trackFetches();
    expect(await readMailbox()).toMatchObject({ messages: 1, receipts: 1 });
    expect(await readMailbox()).toMatchObject({ messages: 0 });
    expect(fetched).toEqual([]);
  });

  it("keeps a message whose processing failed part way, and takes only its missing file from the stored copy next run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    send("m1", { parts: [attachment("a", pdf("a")), attachment("b", pdf("b"))] });
    const store = createMemoryFileStore();
    let puts = 0;
    configure({
      ocr: okOcr(),
      mailbox: mail.reader,
      alerts: testAlerts(),
      people: { submitterByEmail: async () => ALICE },
      fileStore: {
        ...store,
        put: async (key, bytes, sha) => {
          // The raw copy, then file a; file b's write fails.
          if (key.startsWith("receipts/") && ++puts === 2) throw new KindedError("system", "store down");
          return store.put(key, bytes, sha);
        },
      },
    });
    expect(await readMailbox()).toMatchObject({ captured: 1, receipts: 1, failed: 1 });
    expect(await db.receiptMailMessage.findFirstOrThrow()).toMatchObject({ processedAt: null, processError: "system: store down" });
    expect(await db.receiptMailAtRisk.count()).toBe(0);

    const fetched = trackFetches();
    expect(await readMailbox()).toMatchObject({ messages: 1, receipts: 1 });
    expect(fetched).toEqual([]);
    expect(await db.receipt.count()).toBe(2);
    expect(await db.receiptMailMessage.findFirstOrThrow()).toMatchObject({ processedAt: expect.any(Date), processError: null });
  });

  it("reads mail 10 days old after the runs were down", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    send("m1");
    vi.setSystemTime(Date.now() + 10 * DAY_MS);
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
    expect(agingAlerts).toEqual([]);
  });
});

describeDb("mail intake ageing alert", () => {
  const old = (MAIL_WINDOW_DAYS - 1) * DAY_MS + 60_000;
  const raised = () =>
    configure({ ocr: okOcr(), mailbox: mail.reader, alerts: testAlerts(), people: { submitterByEmail: async () => ({ ...ALICE, raisedMailLimit: true }) } });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stays quiet about old mail put off by the cap once it is captured", async () => {
    raised();
    for (let i = 0; i <= MAIL_CAP; i++) send(`m${i}`, { ageMs: old });
    expect(await readMailbox()).toMatchObject({ captured: MAIL_CAP + 1, receipts: MAIL_CAP, deferred: 1 });
    expect(agingAlerts).toEqual([]);
  });

  it("stays quiet when the mail put off is recent enough for the next run", async () => {
    raised();
    for (let i = 0; i <= MAIL_CAP; i++) send(`m${i}`);
    await readMailbox();
    expect(agingAlerts).toEqual([]);
  });

  it("alerts for old mail the run never reached, counting every unread message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    send("m1", { ageMs: old + 2_000 });
    send("m2", { ageMs: old + 1_000 });
    send("m3", { ageMs: old });
    spendBudgetOnFirstCapture();
    expect(await readMailbox()).toMatchObject({ captured: 1, unread: 3 });
    expect(agingAlerts).toMatchObject([{ messages: 2 }]);
  });

  it("alerts for a newer unread message at its own last chance, not with the oldest unread", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    send("m1", { ageMs: old + 1_000 });
    send("m2", { ageMs: old });
    send("newer");
    spendBudgetOnFirstCapture();
    expect(await readMailbox()).toMatchObject({ captured: 1, unread: 3 });
    expect(agingAlerts).toMatchObject([{ messages: 1 }]);

    vi.setSystemTime(Date.now() + old);
    mail.reader.listRecent = async () => {
      throw new Error("Gmail request failed: 401");
    };
    await readMailbox();
    expect(agingAlerts).toMatchObject([{ messages: 1 }, { messages: 1 }]);
  });

  it("alerts for a message that cannot be fetched, since its age is unknown, keeping the known oldest date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    send("m1", { ageMs: old + 1_000 });
    send("m2", { ageMs: old });
    const { getRaw } = mail.reader;
    const listRecent = mail.reader.listRecent;
    mail.reader.listRecent = async (days) => ["gone", ...(await listRecent(days))];
    // "gone" cannot be fetched; capturing m1 then spends the budget, leaving m2 uncaptured and dated.
    mail.reader.getRaw = async (id) => (id === "gone" ? Promise.reject(new Error("Gmail request failed: 500")) : getRaw(id));
    spendBudgetOnFirstCapture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readMailbox()).toMatchObject({ failed: 1, captured: 1 });
    expect(agingAlerts).toMatchObject([{ messages: 2 }]);
    expect(agingAlerts[0].oldestReceivedAt).toBeInstanceOf(Date);
  });

  /** Two stored rows past their last chance, with messages the listing no longer returns. */
  async function storedAtRisk() {
    send("a", { ageMs: old });
    send("b", { ageMs: old });
    mail.reader.listRecent = async () => [];
    const receivedAt = new Date(Date.now() - old);
    await db.receiptMailAtRisk.createMany({ data: ["a", "b"].map((gmailMessageId) => ({ orgId: TEST_ORG_ID, gmailMessageId, receivedAt })) });
  }

  it("finishes the run and still alerts when saving one re-dated row fails", async () => {
    await storedAtRisk();
    const update = vi.spyOn(getPrisma().receiptMailAtRisk, "update").mockRejectedValueOnce(new Error("row lock timeout"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readMailbox()).toMatchObject({ status: "ok" });
    const failedRowId = update.mock.calls[0][0].where.id;
    update.mockRestore();
    expect(agingAlerts).toMatchObject([{ messages: 2 }]);
    expect(logged).toHaveBeenCalledWith(`[receipt] mail ageing re-date failed for row ${failedRowId}:`, expect.any(Error));
  });

  it("fetches at-risk messages one at a time", async () => {
    await storedAtRisk();
    const { getRaw } = mail.reader;
    let inFlight = 0;
    let peak = 0;
    mail.reader.getRaw = async (id) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return getRaw(id);
    };
    await readMailbox();
    expect(agingAlerts).toMatchObject([{ messages: 2 }]);
    expect(peak).toBe(1);
  });

  it("does not alert for an old message once it is captured, though its processing failed", async () => {
    send("m1", { ageMs: old });
    configure({
      ocr: okOcr(),
      mailbox: mail.reader,
      alerts: testAlerts(),
      people: {
        submitterByEmail: async () => {
          throw new Error("people lookup down");
        },
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readMailbox()).toMatchObject({ captured: 1, failed: 1 });
    expect(agingAlerts).toEqual([]);
    expect((await db.receiptMailMessage.findFirstOrThrow()).processError).toBe("bug");
  });

  const age = (days: number) => vi.setSystemTime(Date.now() + days * DAY_MS);

  /** A run where fetching any message fails, so nothing is captured. */
  const failingFetches = () => {
    const { getRaw } = mail.reader;
    mail.reader.getRaw = async () => {
      throw new Error("Gmail request failed: 500");
    };
    return () => {
      mail.reader.getRaw = getRaw;
    };
  };

  it("processes a captured message from its copy after it has left the listing, with no alert", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    configure({ ocr: okOcr(), mailbox: mail.reader, alerts: testAlerts(), rawMailRetentionDays: 90, people: { submitterByEmail: async () => { throw new Error("people lookup down"); } } });
    send("m1");
    expect(await readMailbox()).toMatchObject({ captured: 1, failed: 1 });

    // The runs on the last days of the window never happened; the listing no longer has the message.
    age(MAIL_WINDOW_DAYS + 1);
    mail.messages.delete("m1");
    configure({ ocr: okOcr(), mailbox: mail.reader, alerts: testAlerts(), rawMailRetentionDays: 90, people: { submitterByEmail: async () => ALICE } });
    expect(await readMailbox()).toMatchObject({ messages: 1, receipts: 1 });
    expect(agingAlerts).toEqual([]);
  });

  it("retries an alert whose send failed, then does not repeat it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    failingFetches();
    send("m1", { ageMs: old });
    configure({
      ocr: okOcr(),
      mailbox: mail.reader,
      alerts: { ...testAlerts(), mailAgingOut: async () => { throw new Error("send failed"); } },
    });
    await readMailbox();
    expect(agingAlerts).toEqual([]);

    configure({ ocr: okOcr(), mailbox: mail.reader, alerts: testAlerts() });
    await readMailbox();
    expect(agingAlerts).toHaveLength(1);
    await readMailbox();
    expect(agingAlerts).toHaveLength(1);
  });

  it("alerts once, not daily, for a message that cannot be fetched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const listRecent = mail.reader.listRecent;
    mail.reader.listRecent = async (days) => [...(await listRecent(days)), "gone"];
    await readMailbox();
    await readMailbox();
    expect(agingAlerts).toMatchObject([{ messages: 1, oldestReceivedAt: null }]);
  });

  it("clears a stored message once it is captured, so it never alerts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    send("m0");
    send("m1");
    const spent = spendBudgetOnFirstCapture();
    await readMailbox();
    expect(await db.receiptMailAtRisk.count()).toBe(1);

    spent.mockRestore();
    expect(await readMailbox()).toMatchObject({ captured: 1, receipts: 2 });
    expect(await db.receiptMailAtRisk.count()).toBe(0);
    expect(agingAlerts).toEqual([]);
  });

  it("drops an alerted message once the listing no longer has it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    failingFetches();
    send("m1", { ageMs: old });
    await readMailbox();
    expect(agingAlerts).toHaveLength(1);
    expect(await db.receiptMailAtRisk.count()).toBe(1);

    mail.messages.delete("m1");
    await readMailbox();
    expect(await db.receiptMailAtRisk.count()).toBe(0);
    expect(agingAlerts).toHaveLength(1);
  });
});

describeDb("mail intake listing failure", () => {
  const failListing = () => {
    mail.reader.listRecent = async () => {
      throw new KindedError("connection", "Gmail request failed: 401");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
  };
  const loggedKind = (kind: string) =>
    expect(console.error).toHaveBeenCalledWith(`[receipt] mailbox listing failed (${kind}):`, expect.anything());

  it("reports the failure on each failing run", async () => {
    failListing();
    expect(await readMailbox()).toMatchObject({ status: "listing_failed", messages: 0 });
    expect(await readMailbox()).toMatchObject({ status: "listing_failed" });
    loggedKind("connection");
  });

  it.each([
    [401, "connection"],
    [403, "connection"],
    [404, "settings"],
    [429, "system"],
    [503, "system"],
  ] as const)("logs the cause of a Gmail %i", async (status, kind) => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    mail.reader.listRecent = createGmailReader("receipts@example.org", async () => "token").listRecent;
    try {
      expect(await readMailbox()).toMatchObject({ status: "listing_failed" });
    } finally {
      vi.unstubAllGlobals();
    }
    loggedKind(kind);
  });

  it("reads a Gmail that cannot be reached as an outage", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    mail.reader.listRecent = createGmailReader("receipts@example.org", async () => "token").listRecent;
    try {
      await readMailbox();
    } finally {
      vi.unstubAllGlobals();
    }
    loggedKind("system");
  });

  it("reads an unsorted failure, such as a token-source error, as a bug", async () => {
    mail.reader.listRecent = async () => {
      throw new Error("token source failed");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await readMailbox();
    loggedKind("bug");
  });

  it("still sends the stored ageing alert and the replies owed", async () => {
    await db.receiptMailAtRisk.create({ data: { orgId: TEST_ORG_ID, gmailMessageId: "earlier", receivedAt: new Date(Date.now() - MAIL_WINDOW_DAYS * DAY_MS) } });
    send("m1");
    await readMailbox();
    const sent: string[] = [];
    configure({
      ocr: okOcr(),
      mailbox: mail.reader,
      alerts: testAlerts(),
      people: { submitterByEmail: async () => ALICE },
      replies: {
        contactOf: async () => ({ email: "alice@example.org", name: "Alice" }),
        send: async (ack) => {
          sent.push(ack.to);
          return true;
        },
      },
    });
    failListing();
    expect(await readMailbox()).toMatchObject({ status: "listing_failed", replied: 1 });
    expect(sent).toEqual(["alice@example.org"]);
    expect(agingAlerts).toMatchObject([{ messages: 1 }]);
  });
});

describeDb("mail intake sender authentication", () => {
  const heldAs = async (address: string) => {
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 1 });
    expect((await db.receiptMailItem.findFirstOrThrow()).senderAddress).toBe(address);
  };

  it("holds a message whose DMARC did not pass, recording that the sender is unverified", async () => {
    send("m1", { auth: [GOOGLE_PASS.replace("dmarc=pass", "dmarc=fail")] });
    await heldAs("alice@example.org");
    expect((await db.receiptMailItem.findFirstOrThrow()).holdReason).toBe("unverified_sender");
  });

  it("holds a message whose From address is not ASCII, recording that the sender is unverified", async () => {
    send("m1", { from: ["Alice <alic\u00e9@example.org>"] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 1 });
    expect((await db.receiptMailItem.findFirstOrThrow()).holdReason).toBe("unverified_sender");
  });

  it("holds a member's message that passed DMARC on SPF alone, with no aligned DKIM signature", async () => {
    send("m1", { auth: ["mx.google.com; dkim=pass header.i=@mailer.example.net; spf=pass; dmarc=pass header.from=example.org"] });
    send("m2", { auth: ["mx.google.com; spf=pass; dmarc=pass header.from=example.org"] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 2 });
    expect((await db.receiptMailItem.findMany()).map((i) => i.holdReason)).toEqual(["unverified_sender", "unverified_sender"]);
  });

  it("reads only the topmost Authentication-Results header, and only Google's", async () => {
    send("m1", { auth: [GOOGLE_PASS.replace("mx.google.com", "mx.example.net"), GOOGLE_PASS] });
    await heldAs("alice@example.org");
  });

  it("ignores a forged Google verdict below Google's real one", async () => {
    send("m1", { auth: [GOOGLE_PASS.replace("dmarc=pass", "dmarc=none"), GOOGLE_PASS] });
    await heldAs("alice@example.org");
  });

  it("holds a message with two From headers or two addresses", async () => {
    send("m1", { from: ["alice@example.org", "bob@example.org"] });
    send("m2", { from: ["alice@example.org, bob@example.org"] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 2 });
  });

  it("matches the address, never a display name naming a person", async () => {
    send("m1", { from: ['"alice@example.org" <mallory@example.org>'] });
    await heldAs("mallory@example.org");
  });

  it("never reads identity or files from a forwarded message", async () => {
    send("m1", {
      from: ["stranger@example.org"],
      parts: [
        { mimeType: "text/plain", body: { data: b64(textReceipt("fwd total 9.99")) } },
        {
          mimeType: "message/rfc822",
          headers: [{ name: "From", value: "alice@example.org" }],
          parts: [attachment("inner", pdf("inner"))],
        },
      ],
    });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 2 });
    const items = await db.receiptMailItem.findMany({ orderBy: { id: "asc" } });
    expect(items.map((i) => [i.senderAddress, i.refusal])).toEqual([
      ["stranger@example.org", null],
      ["stranger@example.org", [{ file: "an attached email", reason: "forwarded" }]],
    ]);
    expect(await storedBytes(items[0].fileKey)).toBe(textReceipt("fwd total 9.99"));
  });

  it("never opens a message forwarded as an attachment, and counts it ignored", async () => {
    send("m1", {
      parts: [
        { mimeType: "text/plain", body: { data: b64("see attached") } },
        { mimeType: "message/rfc822", filename: "receipt.eml", parts: [{ mimeType: "text/plain", body: { data: b64("Order total 12.00") } }] },
      ],
    });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 0, ignored: 2 });
    expect(await db.receiptMailItem.count()).toBe(0);
  });
});

describeDb("mail intake over a sender's daily upload limit", () => {
  const people: Record<string, typeof ALICE> = { "alice@example.org": ALICE, "bob@example.org": BOB };
  let lookups: string[];

  function withLimits(limits: Partial<ReceiptLimits>, known = people): void {
    lookups = [];
    configure({
      ocr: okOcr(),
      mailbox: mail.reader,
      alerts: testAlerts(),
      limits,
      people: {
        submitterByEmail: async (address) => {
          lookups.push(address);
          return known[address] ?? null;
        },
      },
    });
  }

  let seq = 0;
  async function deferredFor(address: string): Promise<number> {
    const n = ++seq;
    const row = await db.receiptMailItem.create({
      data: {
        orgId: TEST_ORG_ID,
        gmailMessageId: `old${n}`,
        attachmentHash: `h${n}`,
        receivedAt: new Date(Date.now() - 60_000 + n),
        senderAddress: address,
        status: "deferred",
        fileKey: await storeFile(Buffer.from(pdf(`deferred ${n}`))),
        mimeType: "application/pdf",
      },
    });
    return row.id;
  }

  it("defers the file with its bytes, then makes it a receipt on a later run once the sender has allowance", async () => {
    withLimits({ mailUploadsPerPersonPerDay: 1 });
    send("m1");
    send("m2");
    expect(await readMailbox()).toMatchObject({ receipts: 1, held: 0, overLimit: 1 });
    const deferred = await db.receiptMailItem.findFirstOrThrow({ where: { status: "deferred" } });
    expect(deferred).toMatchObject({ gmailMessageId: "m2", senderAddress: "alice@example.org", receiptId: null });
    expect(await storedBytes(deferred.fileKey)).toBe(pdf("m2"));

    // m2 was processed from its copy; its deferred file waits for a retry, not a re-read.
    const fetched = trackFetches();
    expect(await readMailbox()).toMatchObject({ messages: 0, receipts: 0, overLimit: 0, skipped: 1 });
    expect(fetched).toEqual([]);

    withLimits({ mailUploadsPerPersonPerDay: 30 });
    mail.messages.clear();
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
    const item = await db.receiptMailItem.findUniqueOrThrow({ where: { id: deferred.id } });
    expect(item).toMatchObject({ status: "assigned", fileBlob: null });
    const receipt = await db.receipt.findUniqueOrThrow({ where: { id: item.receiptId ?? "" } });
    expect(receipt).toMatchObject({ uploadedByUserId: ALICE.id, intakeSource: "email" });
  });

  it("discards a deferred body that repeats its message's attachment once it is retried", async () => {
    withLimits({ mailUploadsPerPersonPerDay: 1 });
    send("m1", { parts: [{ mimeType: "text/plain", body: { data: b64(textReceipt("Order total 5.00")) } }, attachment("a", pdf("a"))] });
    expect(await readMailbox()).toMatchObject({ receipts: 1, overLimit: 1 });

    withLimits({ mailUploadsPerPersonPerDay: 30 });
    mail.messages.clear();
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
    const body = await db.receiptMailItem.findFirstOrThrow({ where: { gmailMessageId: "m1" }, orderBy: { id: "desc" } });
    expect(await stateOf(body.receiptId ?? "")).toBe("discarded");
  });

  it("spends no cap and no reading on a refused retry, and skips that sender's other deferred files for the run", async () => {
    withLimits({ mailUploadsPerPersonPerDay: 1 });
    send("a0");
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
    mail.messages.clear();
    for (let i = 0; i <= MAIL_CAP; i++) await deferredFor("alice@example.org");
    send("bob1", { from: ["bob@example.org"] });
    withLimits({ mailUploadsPerPersonPerDay: 1 });

    expect(await readMailbox()).toMatchObject({ receipts: 1, failed: 0 });
    expect(lookups.filter((a) => a === "alice@example.org")).toHaveLength(1);
    expect(await db.receiptMailItem.count({ where: { status: "deferred" } })).toBe(MAIL_CAP + 1);
    expect(await db.receiptAuditLog.count({ where: { action: "ocr_call", userId: ALICE.id } })).toBe(1);
    expect((await db.receipt.findFirstOrThrow({ where: { uploadedByUserId: BOB.id } })).intakeSource).toBe("email");
  });

  it("stops every retry for the run once the org-wide upload limit refuses one", async () => {
    await deferredFor("alice@example.org");
    await deferredFor("bob@example.org");
    withLimits({ uploadBytesPerDay: 0 });
    expect(await readMailbox()).toMatchObject({ receipts: 0, failed: 0 });
    expect(lookups).toEqual(["alice@example.org"]);
  });

  it("holds a deferred file for finance once its sender is no longer a submitter", async () => {
    const id = await deferredFor("alice@example.org");
    expect((await db.receiptMailItem.findUniqueOrThrow({ where: { id } })).heldAt).toBeNull();
    withLimits({}, {});
    const before = new Date();
    expect(await readMailbox()).toMatchObject({ receipts: 0 });
    const held = await db.receiptMailItem.findUniqueOrThrow({ where: { id } });
    expect(held).toMatchObject({ status: "held", holdReason: "not_a_submitter" });
    expect(held.heldAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("counts deferred files toward the held ceiling", async () => {
    withLimits({ mailUploadsPerPersonPerDay: 0 });
    await db.receiptMailItem.createMany({
      data: Array.from({ length: MAIL_HELD_CEILING }, (_, i) => ({
        orgId: TEST_ORG_ID,
        gmailMessageId: `full${i}`,
        attachmentHash: `f${i}`,
        receivedAt: new Date(),
        senderAddress: i === 0 ? "alice@example.org" : "stranger@example.org",
        status: i === 0 ? "deferred" : "held",
      })),
    });
    send("m1");
    expect(await readMailbox()).toMatchObject({ overLimit: 0, overCeiling: 1 });
    expect(alerts).toHaveLength(1);
  });

  it("gives a program lead or Board member the raised mail limit", async () => {
    withLimits({ mailUploadsPerPersonPerDay: 1, mailUploadsPerRaisedPersonPerDay: 2 }, { "alice@example.org": { ...ALICE, raisedMailLimit: true } });
    send("m1");
    send("m2");
    send("m3");
    expect(await readMailbox()).toMatchObject({ receipts: 2, overLimit: 1 });
  });

  it("counts mailed receipts toward the manual upload limit", async () => {
    withLimits({ uploadsPerPersonPerDay: 1 });
    send("m1");
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
    await expect(uploadRead(textFile(), "text/plain", { details: manualDetails() })).rejects.toMatchObject({ status: 429 });
  });

  it("counts only mailed receipts toward the mail limit", async () => {
    withLimits({ uploadsPerPersonPerDay: 2, mailUploadsPerPersonPerDay: 1 });
    await uploadRead(textFile(), "text/plain", { details: manualDetails() });
    send("m1");
    send("m2");
    expect(await readMailbox()).toMatchObject({ receipts: 1, overLimit: 1 });
  });

  it("stores the sender check's verdict on every item", async () => {
    send("passed");
    send("spf-only", { auth: ["mx.google.com; spf=pass smtp.mailfrom=alice@example.org; dmarc=pass header.from=example.org"] });
    send("no-record", { auth: ["mx.google.com; spf=pass; dmarc=none header.from=example.org"] });
    send("no-from", { from: ["a@example.org, b@example.org"] });
    await readMailbox();
    const items = await db.receiptMailItem.findMany();
    expect(Object.fromEntries(items.map((i) => [i.gmailMessageId, [i.status, i.dmarcVerdict]]))).toEqual({
      passed: ["assigned", "pass"],
      "spf-only": ["held", "fail"],
      "no-record": ["held", "none"],
      "no-from": ["held", "fail"],
    });
  });
});

describeDb("mail intake with files in the store", () => {
  let store: ReturnType<typeof createMemoryFileStore>;

  function configureStore(limits: Partial<ReceiptLimits> = {}): void {
    configure({
      ocr: okOcr(),
      mailbox: mail.reader,
      alerts: testAlerts(),
      limits,
      fileStore: store,
      people: { submitterByEmail: async (address) => (address === "alice@example.org" ? ALICE : null) },
    });
  }

  const stored = (key: string | null) => Buffer.from(store.objects.get(key ?? "") ?? []).toString();

  /** Mails two files from Alice under a limit of one: one receipt, and one item deferred in the store. */
  async function deferOne() {
    configureStore({ mailUploadsPerPersonPerDay: 1 });
    send("m1");
    send("m2");
    expect(await readMailbox()).toMatchObject({ receipts: 1, overLimit: 1 });
    const item = await db.receiptMailItem.findFirstOrThrow({ where: { status: "deferred" } });
    expect(item).toMatchObject({ fileBlob: null, fileSize: pdf("m2").length });
    expect(item.fileKey).toMatch(/^mail-items\//);
    expect(stored(item.fileKey)).toBe(pdf("m2"));
    mail.messages.clear();
    return item;
  }

  beforeEach(() => {
    store = createMemoryFileStore();
    configureStore();
  });

  it("stores a mailed receipt's file and the raw email, leaving no mail item object", async () => {
    send("m1");
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
    const receipt = await db.receipt.findFirstOrThrow();
    expect(receipt).toMatchObject({ fileBlob: null, fileKey: `receipts/${receipt.id}` });
    const { rawKey } = await db.receiptMailMessage.findFirstOrThrow();
    expect([...store.objects.keys()].sort()).toEqual([rawKey, receipt.fileKey].sort());
  });

  it("holds an unknown sender's file in the store and not in the row", async () => {
    send("m1", { from: ["Stranger <stranger@example.org>"] });
    expect(await readMailbox()).toMatchObject({ held: 1 });
    const item = await db.receiptMailItem.findFirstOrThrow();
    expect(item).toMatchObject({ status: "held", fileBlob: null, fileSize: pdf("m1").length });
    expect(stored(item.fileKey)).toBe(pdf("m1"));
  });

  it("a held file the store refuses leaves no row", async () => {
    configure({
      ocr: okOcr(),
      mailbox: mail.reader,
      alerts: testAlerts(),
      fileStore: { ...store, put: async (key, bytes, sha) => (key.startsWith("mail-items/") ? Promise.reject(new Error("s3 down")) : store.put(key, bytes, sha)) },
      people: { submitterByEmail: async () => null },
    });
    send("m1", { from: ["Stranger <stranger@example.org>"] });
    expect(await readMailbox()).toMatchObject({ held: 0, failed: 1 });
    expect(await db.receiptMailItem.count()).toBe(0);
  });

  it("a retried deferred item becomes a stored receipt and its mail object is deleted", async () => {
    const item = await deferOne();
    configureStore({ mailUploadsPerPersonPerDay: 30 });
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
    const after = await db.receiptMailItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after).toMatchObject({ status: "assigned", fileKey: null, fileBlob: null });
    expect(store.objects.has(item.fileKey ?? "")).toBe(false);
    expect(stored(`receipts/${after.receiptId}`)).toBe(pdf("m2"));
  });

  it("a released deferred item becomes a stored receipt and its mail object is deleted", async () => {
    const item = await deferOne();
    actAs(FINANCE);
    const { receiptId } = await mailQueueService.assign(item.id, { release: true });
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "assigned", fileKey: null });
    expect(store.objects.has(item.fileKey ?? "")).toBe(false);
    expect(stored(`receipts/${receiptId}`)).toBe(pdf("m2"));
  });

  it("a deferred item whose object is gone counts as failed and stays deferred", async () => {
    const item = await deferOne();
    store.objects.delete(item.fileKey ?? "");
    configureStore({ mailUploadsPerPersonPerDay: 30 });
    expect(await readMailbox()).toMatchObject({ receipts: 0, failed: 1 });
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "deferred" });
  });
});
