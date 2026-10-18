// The FINANCE mail queue (#1265 §2a): mailed receipts held for an unknown or unauthenticated
// sender, and those deferred for a known sender over their daily upload limit. Finance assigns
// each to a submitter, which runs it through the mailed intake as that person, releases a
// deferred one as its sender now, or discards it with a reason. Every view and action is audited.
import { z } from "zod";
import { db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import type { ReceiptPrincipal } from "../contract";
import { getOrg, ports, requireActor } from "../runtime";
import { intakeDeferred, STORED_STATUSES } from "./mailIntake";
import { intakeMailedReceipt } from "./receiptService";
import { ServiceError } from "@checkin/component-kit";

const ITEM_FIELDS = { id: true, receivedAt: true, senderAddress: true, status: true, mimeType: true, receiptId: true } as const;

const AssignSchema = z.union([
  z.object({ email: z.string().trim().min(1).max(320) }).strict(),
  z.object({ release: z.literal(true) }).strict(),
]);
const DiscardSchema = z.object({ reason: z.string().trim().min(1, "A reason is required").max(500) }).strict();

export const CANNOT_ASSIGN = "This receipt can't be assigned to that email";

type Tx = Prisma.TransactionClient | typeof db;

/** One audit row about a mail item; it belongs to no receipt, so the item id rides in valueBefore. */
const auditItem = (tx: Tx, actor: ReceiptPrincipal, itemId: number, action: string, valueAfter: string | null = null) =>
  tx.receiptAuditLog.create({
    data: { receiptId: null, userId: actor.id, username: actor.name, action, fieldChanged: "mail_item", valueBefore: String(itemId), valueAfter },
  });

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new ServiceError(400, result.error.issues.map((i) => i.message).join("; "));
  return result.data;
}

async function storedItem(id: number) {
  const item = await db.receiptMailItem.findFirst({
    where: { id, orgId: (await getOrg()).id, status: { in: STORED_STATUSES } },
    select: { ...ITEM_FIELDS, fileBlob: true },
  });
  if (!item?.fileBlob || !item.mimeType) throw new ServiceError(404, "Mail item not found");
  return { ...item, fileBlob: item.fileBlob, mimeType: item.mimeType };
}

export const mailQueueService = {
  /** Held and deferred items, oldest first. Each one shown writes a view row. */
  async listHeld() {
    const actor = await requireActor();
    const items = await db.receiptMailItem.findMany({
      where: { orgId: (await getOrg()).id, status: { in: STORED_STATUSES } },
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
   * Make the stored file a receipt uploaded by the submitter with this sign-in email, or, with
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
    const { fileBlob: _file, ...shown } = item;
    if (release) {
      const receiptId = await intakeDeferred(item, assignee, { uploadLimits: false, onClaim: auditClaim });
      return { ...shown, status: "assigned", receiptId };
    }
    const receiptId = await intakeMailedReceipt(assignee, Buffer.from(item.fileBlob), item.mimeType, async (tx, newId) => {
      const claimed = await tx.receiptMailItem.updateMany({
        where: { id, status: { in: STORED_STATUSES } },
        data: { status: "assigned", receiptId: newId, fileBlob: null },
      });
      if (claimed.count !== 1) throw new ServiceError(409, "This mail item was already handled. Refresh and retry.");
      await auditClaim(tx, newId);
    }, { mailAllowance: false });
    return { ...shown, status: "assigned", receiptId };
  },

  async discard(id: number, rawInput: unknown) {
    const actor = await requireActor();
    const { reason } = parse(DiscardSchema, rawInput);
    const orgId = (await getOrg()).id;
    return db.$transaction(async (tx) => {
      const done = await tx.receiptMailItem.updateMany({ where: { id, orgId, status: { in: STORED_STATUSES } }, data: { status: "discarded", fileBlob: null } });
      if (done.count !== 1) throw new ServiceError(404, "Mail item not found");
      await auditItem(tx, actor, id, "mail_discarded", reason);
      return tx.receiptMailItem.findUniqueOrThrow({ where: { id }, select: ITEM_FIELDS });
    });
  },
};
