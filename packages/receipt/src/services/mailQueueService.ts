// The FINANCE mail queue (#1265 §2a): mailed receipts held for an unknown or unauthenticated
// sender, and those deferred for a known sender over their daily upload limit. Finance assigns
// each to a submitter, which runs it through the mailed intake as that person, releases a
// deferred one as its sender now, or discards it with a reason. Finance also keeps the ignore
// list of files intake skips. Every view of a held file and every action is audited.
import { z } from "zod";
import { db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import type { ReceiptPrincipal } from "../contract";
import { getOrgId, ports, requireActor } from "../runtime";
import { intakeDeferred, STORED_STATUSES, type DmarcVerdict } from "./mailIntake";
import { intakeMailedReceipt } from "./receiptService";
import { closeUnreplyable } from "./mailReplies";
import { deleteStoredFiles, readStoredFile } from "../lib/fileStorage";
import { ServiceError } from "@checkin/component-kit";

const ITEM_FIELDS = { id: true, receivedAt: true, senderAddress: true, status: true, holdReason: true, dmarcVerdict: true, mimeType: true, receiptId: true } as const;

const AssignSchema = z.union([
  z.object({ email: z.string().trim().min(1).max(320) }).strict(),
  z.object({ release: z.literal(true) }).strict(),
]);
const REASON = z.string().trim().min(1, "A reason is required").max(500);
const IGNORABLE_STATES = new Set(["discarded", "rejected"]);
const DiscardSchema = z.object({ reason: REASON, ignoreFile: z.literal(true).optional() }).strict();
const IgnoreSchema = z.object({ reason: REASON }).strict();

const IGNORED_FIELDS = { id: true, orgId: true, fileHash: true, reason: true, addedByUserId: true, createdAt: true } as const;

export const CANNOT_ASSIGN = "This receipt can't be assigned to that email";

type Tx = Prisma.TransactionClient | typeof db;

/** One audit row about a mail item; it belongs to no receipt, so the item id rides in valueBefore. */
const auditItem = (tx: Tx, actor: ReceiptPrincipal, itemId: number, action: string, valueAfter: string | null = null) =>
  tx.receiptAuditLog.create({
    data: { receiptId: null, userId: actor.id, username: actor.name, action, fieldChanged: "mail_item", valueBefore: String(itemId), valueAfter },
  });

/** One audit row about the ignore list; it belongs to no receipt, so no receipt's audit view returns it. */
const auditIgnored = (tx: Tx, actor: ReceiptPrincipal, action: string, fieldChanged: string, valueBefore: string, valueAfter: string) =>
  tx.receiptAuditLog.create({ data: { receiptId: null, userId: actor.id, username: actor.name, action, fieldChanged, valueBefore, valueAfter } });

/** Lists the file unless it already is; a new entry is audited against its source, `kind` and `sourceId`. */
async function addIgnored(tx: Prisma.TransactionClient, actor: ReceiptPrincipal, fileHash: string, reason: string, kind: string, sourceId: string) {
  const orgId = await getOrgId();
  const added = await tx.receiptIgnoredFile.createMany({ data: [{ orgId, fileHash, reason, addedByUserId: actor.id }], skipDuplicates: true });
  if (added.count === 1) await auditIgnored(tx, actor, "file_ignored", kind, sourceId, reason);
  return tx.receiptIgnoredFile.findUniqueOrThrow({ where: { orgId_fileHash: { orgId, fileHash } }, select: IGNORED_FIELDS });
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new ServiceError(400, result.error.issues.map((i) => i.message).join("; "));
  return result.data;
}

async function storedItem(id: number) {
  const item = await db.receiptMailItem.findFirst({
    where: { id, orgId: await getOrgId(), status: { in: STORED_STATUSES } },
    select: { ...ITEM_FIELDS, fileBlob: true, fileKey: true },
  });
  const fileBlob = item && (await readStoredFile(item));
  if (!item || !fileBlob || !item.mimeType) throw new ServiceError(404, "Mail item not found");
  return { ...item, fileBlob, mimeType: item.mimeType };
}

export const mailQueueService = {
  /** Held and deferred items, oldest first. Each one shown writes a view row. */
  async listHeld() {
    const actor = await requireActor();
    const items = await db.receiptMailItem.findMany({
      where: { orgId: await getOrgId(), status: { in: STORED_STATUSES } },
      select: ITEM_FIELDS,
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    });
    if (items.length > 0) {
      await db.receiptAuditLog.createMany({
        data: items.map((i) => ({
          receiptId: null,
          userId: actor.id,
          username: actor.name,
          action: "mail_item_viewed",
          fieldChanged: "mail_item",
          valueBefore: String(i.id),
        })),
      });
    }
    return items;
  },

  async getFile(id: number): Promise<{ id: number; fileBlob: Uint8Array; mimeType: string }> {
    const actor = await requireActor();
    const item = await storedItem(id);
    await auditItem(db, actor, id, "mail_file_viewed");
    return { id, fileBlob: item.fileBlob, mimeType: item.mimeType };
  },

  /**
   * Make the stored file a receipt uploaded by the submitter this email resolves to, or, with
   * `release`, make a deferred file a receipt by its own sender now, outside their daily upload
   * limit for this file only. Nobody assigns or releases a receipt to themself or their own
   * household. The item flips to `assigned` in the receipt's own insert, so a concurrent assign,
   * release, retry or discard leaves no second receipt.
   */
  async assign(id: number, rawInput: unknown) {
    const actor = await requireActor();
    const input = parse(AssignSchema, rawInput);
    const item = await storedItem(id);
    const release = "release" in input;
    if (release && item.status !== "deferred") throw new ServiceError(409, "Only a deferred mail item can be released");
    const assignee = await ports().people.submitterByEmail(release ? item.senderAddress : input.email.toLowerCase());
    // One answer for every unusable email (no one, several, unverified, not a submitter): no existence oracle.
    if (!assignee) throw new ServiceError(404, CANNOT_ASSIGN);
    const conflicted = [actor.id, ...(await ports().households.householdOf([actor.id]))];
    if (conflicted.includes(assignee.id)) {
      await auditItem(db, actor, id, "mail_assign_refused");
      throw new ServiceError(403, "You cannot assign a receipt to yourself or your household");
    }
    const auditClaim = (tx: Prisma.TransactionClient, newId: string) =>
      tx.receiptAuditLog.create({
        data: { receiptId: newId, userId: actor.id, username: actor.name, action: release ? "mail_released" : "mail_assigned", fieldChanged: "mail_item", valueBefore: String(id) },
      });
    const { fileBlob: _file, fileKey: _key, ...shown } = item;
    if (release) {
      const receiptId = await intakeDeferred(item, assignee, { uploadLimits: false, onClaim: auditClaim });
      return { ...shown, status: "assigned", receiptId };
    }
    const receiptId = await intakeMailedReceipt(assignee, Buffer.from(item.fileBlob), item.mimeType, async (tx, newId) => {
      const claimed = await tx.receiptMailItem.updateMany({
        where: { id, status: { in: STORED_STATUSES } },
        data: { status: "assigned", receiptId: newId, fileBlob: null, fileKey: null },
      });
      if (claimed.count !== 1) throw new ServiceError(409, "This mail item was already handled. Refresh and retry.");
      await auditClaim(tx, newId);
    }, { mailAllowance: false, heldFileKey: item.fileKey });
    return { ...shown, status: "assigned", receiptId };
  },

  /**
   * An item from exactly this address that passed the sender check and became a receipt of this
   * person's, else null. A discarded receipt does not count: discarding is how a credited person
   * says the mail is not theirs.
   */
  async assignedPassingItem(address: string, personId: number): Promise<{ id: number } | null> {
    await requireActor();
    const orgId = await getOrgId();
    const items = await db.receiptMailItem.findMany({
      where: { orgId, senderAddress: address, status: "assigned", dmarcVerdict: "pass" satisfies DmarcVerdict, receiptId: { not: null } },
      select: { id: true, receiptId: true },
      orderBy: { id: "asc" },
    });
    const counted = await db.receipt.findMany({
      where: { id: { in: items.flatMap((i) => (i.receiptId ? [i.receiptId] : [])) }, orgId, uploadedByUserId: personId, details: { isNot: { state: "discarded" } } },
      select: { id: true },
    });
    const ids = new Set(counted.map((r) => r.id));
    const item = items.find((i) => i.receiptId && ids.has(i.receiptId));
    return item ? { id: item.id } : null;
  },

  /**
   * Discard a stored item with a reason. With `ignoreFile`, the same transaction lists its file
   * and discards every other stored item with that file, each audited with the same reason.
   * A discarded row keeps its fileKey, naming the deleted object for an admin restore.
   */
  async discard(id: number, rawInput: unknown) {
    const actor = await requireActor();
    const { reason, ignoreFile } = parse(DiscardSchema, rawInput);
    const orgId = await getOrgId();
    const { item, fileKeys } = await db.$transaction(async (tx) => {
      const done = await tx.receiptMailItem.updateMany({ where: { id, orgId, status: { in: STORED_STATUSES } }, data: { status: "discarded", fileBlob: null } });
      if (done.count !== 1) throw new ServiceError(404, "Mail item not found");
      await auditItem(tx, actor, id, "mail_discarded", reason);
      const { attachmentHash, gmailMessageId, fileKey, ...item } = await tx.receiptMailItem.findUniqueOrThrow({
        where: { id },
        select: { ...ITEM_FIELDS, attachmentHash: true, gmailMessageId: true, fileKey: true },
      });
      const messages = [gmailMessageId];
      const fileKeys = [fileKey];
      if (ignoreFile) {
        await addIgnored(tx, actor, attachmentHash, reason, "mail_item", String(id));
        const copies = await tx.receiptMailItem.updateManyAndReturn({
          where: { orgId, attachmentHash, status: { in: STORED_STATUSES } },
          data: { status: "discarded", fileBlob: null },
          select: { id: true, gmailMessageId: true, fileKey: true },
        });
        fileKeys.push(...copies.map((c) => c.fileKey));
        for (const copy of copies) await auditItem(tx, actor, copy.id, "mail_discarded", reason);
        messages.push(...copies.map((c) => c.gmailMessageId));
      }
      await closeUnreplyable(tx, messages);
      return { item, fileKeys };
    });
    await deleteStoredFiles(fileKeys);
    return item;
  },

  /** Ignore-list entries, newest first. */
  async listIgnored() {
    await requireActor();
    return db.receiptIgnoredFile.findMany({ where: { orgId: await getOrgId() }, select: IGNORED_FIELDS, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  },

  /** List a discarded or rejected receipt's file. Receipts already made from it are left as they are. */
  async ignoreReceiptFile(receiptId: string, rawInput: unknown) {
    const actor = await requireActor();
    const { reason } = parse(IgnoreSchema, rawInput);
    const receipt = await db.receipt.findFirst({ where: { id: receiptId, orgId: await getOrgId() }, select: { fileHash: true, details: { select: { state: true } } } });
    if (!receipt) throw new ServiceError(404, "Receipt not found");
    if (!IGNORABLE_STATES.has(receipt.details?.state ?? "")) throw new ServiceError(409, "Only a discarded or rejected receipt's file can be ignored");
    return db.$transaction((tx) => addIgnored(tx, actor, receipt.fileHash, reason, "receipt", receiptId));
  },

  /** Remove an entry; intake reads that file in mail it has not yet skipped. Audited like an add. */
  async removeIgnored(id: number) {
    const actor = await requireActor();
    const orgId = await getOrgId();
    return db.$transaction(async (tx) => {
      const entry = await tx.receiptIgnoredFile.findFirst({ where: { id, orgId }, select: IGNORED_FIELDS });
      const removed = entry && (await tx.receiptIgnoredFile.deleteMany({ where: { id, orgId } }));
      if (!entry || removed?.count !== 1) throw new ServiceError(404, "Ignored file not found");
      await auditIgnored(tx, actor, "file_unignored", "ignored_file", entry.fileHash, entry.reason);
      return entry;
    });
  },
};
