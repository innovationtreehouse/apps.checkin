import { isRecordNotFoundError, isUniqueConstraintError, type Db } from "../db/index";
import type { InventoryProvisionalItem, OrgItem } from "../db/schema";
import type { InventoryRepository } from "../repositories/inventoryRepository";
import type { ReceiveQueueRepository } from "../repositories/receiveQueueRepository";
import { applyQtyChangeIn } from "./inventoryService";
import type { ProvisionalItemService } from "./provisionalItemService";
import { ServiceError } from "./serviceError";

export type ApplyLineItem = {
  gtin13: string;
  quantityDelta: number;
  isDelayed?: boolean;
  lineItemId?: number;
  isProvisional?: boolean;
  provisionalName?: string;
  conversionFactor?: number;
  conversionVersion?: number;
};

/** In-kind goods are in hand, so a donation line is never delayed into the receive queue. */
export type DonationLineItem = Omit<ApplyLineItem, "isDelayed" | "lineItemId">;

type ApplySource =
  | { kind: "receipt"; receiptId: string; retailer?: string }
  | { kind: "donation"; donationId: string };

export type ApplyResult = {
  success: true;
  /** True when this source was already applied: nothing changed and the earlier result is returned. */
  replayed: boolean;
  updatedItems: Array<{ gtin13: string; newQuantity: number }>;
};

function sourceKey(source: ApplySource): string {
  return source.kind === "receipt" ? `receipt:${source.receiptId}` : `donation:${source.donationId}`;
}

/** Canonical delta JSON: defaults filled in and keys in a fixed order, so equal payloads compare equal. */
function normalisedDeltaJson(source: ApplySource, lineItems: ApplyLineItem[]): string {
  const src =
    source.kind === "receipt"
      ? { kind: source.kind, receiptId: source.receiptId, retailer: source.retailer ?? null }
      : { kind: source.kind, donationId: source.donationId };
  const lines = lineItems.map((li) => ({
    gtin13: li.gtin13,
    quantityDelta: li.quantityDelta,
    isDelayed: li.isDelayed ?? false,
    lineItemId: li.lineItemId ?? null,
    isProvisional: li.isProvisional ?? false,
    provisionalName: li.provisionalName ?? null,
    conversionFactor: li.conversionFactor ?? 1,
    conversionVersion: li.conversionVersion ?? 1,
  }));
  return JSON.stringify({ source: src, lineItems: lines });
}

/**
 * The earlier result when this source is already applied. An applied source replayed with a
 * different delta is a 409: the stock already reflects the first delta and must not silently stay stale.
 */
function replayOf(
  row: { status: string; deltaJson: string; resultJson: string | null } | null,
  deltaJson: string,
): ApplyResult | null {
  if (row?.status !== "applied") return null;
  if (row.deltaJson !== deltaJson) {
    throw new ServiceError(409, "This source was already applied with a different inventory delta.");
  }
  const updatedItems: ApplyResult["updatedItems"] = JSON.parse(row.resultJson ?? "[]");
  return { success: true, replayed: true, updatedItems };
}

export function createReceiptService({
  provisionalItemService,
  inventoryRepo,
  receiveQueueRepo,
  db,
}: {
  provisionalItemService: ProvisionalItemService;
  inventoryRepo: InventoryRepository;
  receiveQueueRepo: ReceiveQueueRepository;
  db: Db;
}) {
  async function earlierResult(orgId: string, key: string, deltaJson: string): Promise<ApplyResult | null> {
    return replayOf(
      await db.receivedInventoryDelta.findUnique({ where: { orgId_sourceKey: { orgId, sourceKey: key } } }),
      deltaJson,
    );
  }

  // Best effort: the apply error is what the caller needs, so a failure to record it is dropped.
  async function recordFailure(orgId: string, key: string, receiptId: string | null, deltaJson: string, err: unknown) {
    const failureReason = err instanceof Error ? err.message : String(err);
    try {
      await db.receivedInventoryDelta.create({
        data: { orgId, sourceKey: key, receiptId, deltaJson, status: "failed", failureReason },
      });
    } catch (createErr) {
      if (!isUniqueConstraintError(createErr)) return;
      await db.receivedInventoryDelta
        .updateMany({ where: { orgId, sourceKey: key, status: "failed" }, data: { deltaJson, failureReason } })
        .catch(() => undefined);
    }
  }

  /**
   * Apply a source's line items at most once per (org, source key). The guard row in
   * ReceivedInventoryDelta and every stock change commit in one transaction, so a failed apply
   * leaves nothing behind but a "failed" record, and a concurrent duplicate fails on the unique
   * key (or the stock row it races on) and is answered as a replay. Replaying an applied source
   * with a different delta is a 409.
   */
  async function apply(orgId: string, source: ApplySource, lineItems: ApplyLineItem[]): Promise<ApplyResult> {
    const key = sourceKey(source);
    const receiptId = source.kind === "receipt" ? source.receiptId : null;
    const deltaJson = normalisedDeltaJson(source, lineItems);
    const createdProvisionals: string[] = [];

    let result: ApplyResult;
    try {
      result = await db.$transaction(async (tx) => {
        const prior = await tx.receivedInventoryDelta.findUnique({
          where: { orgId_sourceKey: { orgId, sourceKey: key } },
        });
        const replay = replayOf(prior, deltaJson);
        if (replay) return replay;

        const updatedItems: ApplyResult["updatedItems"] = [];
        for (const li of lineItems) {
          if (!li.gtin13) continue;

          if (li.isProvisional) {
            const existing = await tx.inventoryProvisionalItem.findFirst({
              where: { provisionalGtin13: li.gtin13, orgId },
            });
            if (!existing) {
              await tx.inventoryProvisionalItem.create({
                data: {
                  provisionalGtin13: li.gtin13,
                  name: li.provisionalName ?? li.gtin13,
                  usageBehavior: "Unknown",
                  orgId,
                  status: "pending",
                  proposedAt: new Date(),
                  // Remember the factor this provisional's stock was counted under,
                  // so a later map-to-existing can detect a unit mismatch.
                  conversionFactor: li.conversionFactor ?? 1,
                },
              });
              createdProvisionals.push(li.gtin13);
            }
          }

          if (li.isDelayed && source.kind === "receipt") {
            await tx.receiveQueue.create({
              data: {
                orgId,
                gtin13: li.gtin13,
                quantity: li.quantityDelta,
                conversionFactor: li.conversionFactor ?? 1,
                conversionVersion: li.conversionVersion ?? 1,
                retailer: source.retailer ?? "",
                receiptId: source.receiptId,
                lineItemId: li.lineItemId ?? 0,
                queuedAt: new Date(),
              },
            });
            continue;
          }

          const newQuantity = await applyQtyChangeIn(tx, orgId, li.gtin13, li.quantityDelta, {
            userId: null,
            changeType: "automatic",
            receiptId,
            conversionFactor: li.conversionFactor ?? 1,
            conversionVersion: li.conversionVersion ?? 1,
          });
          updatedItems.push({ gtin13: li.gtin13, newQuantity });
        }

        const applied = { status: "applied", deltaJson, resultJson: JSON.stringify(updatedItems), failureReason: null };
        if (prior) {
          await tx.receivedInventoryDelta.update({ where: { id: prior.id, status: "failed" }, data: applied });
        } else {
          await tx.receivedInventoryDelta.create({ data: { orgId, sourceKey: key, receiptId, ...applied } });
        }
        return { success: true, replayed: false, updatedItems };
      });
    } catch (err) {
      if (err instanceof ServiceError) throw err;
      if (isUniqueConstraintError(err) || isRecordNotFoundError(err)) {
        const replay = await earlierResult(orgId, key, deltaJson);
        if (replay) return replay;
      }
      await recordFailure(orgId, key, receiptId, deltaJson, err);
      throw err;
    }

    // Reconcile-on-ingest, after commit since it runs its own transactions: if a catalog
    // resolution for a new provisional GTIN already arrived (event-before-row), apply it now.
    for (const gtin13 of createdProvisionals) {
      await provisionalItemService.reconcileProvisionalOnCreate(orgId, gtin13);
    }
    return result;
  }

  return {
    async applyReceipt(orgId: string, receiptId: string, retailer: string | undefined, lineItems: ApplyLineItem[]) {
      return apply(orgId, { kind: "receipt", receiptId, retailer }, lineItems);
    },

    async applyDonation(orgId: string, donationId: string, lineItems: DonationLineItem[]) {
      return apply(orgId, { kind: "donation", donationId }, lineItems);
    },

    async getOrgItem(gtin13: string, orgId: string) {
      return inventoryRepo.findOne(orgId, gtin13);
    },

    async createProvisional(
      orgId: string,
      data: {
        provisionalGtin13: string;
        name: string;
        proposedCategoryId?: number;
        proposedSubcategoryId?: number;
        usageBehavior: string;
        proposedByUserId: number;
        receiptId: string;
        conversionFactor?: number;
      },
    ): Promise<{ provisionalItem: InventoryProvisionalItem; orgItem: OrgItem }> {
      const now = new Date();

      const result = await db.$transaction(async (tx) => {
        const provisionalItem = await tx.inventoryProvisionalItem.create({
          data: {
            provisionalGtin13: data.provisionalGtin13,
            name: data.name,
            proposedCategoryId: data.proposedCategoryId ?? null,
            proposedSubcategoryId: data.proposedSubcategoryId ?? null,
            usageBehavior: data.usageBehavior,
            proposedByUserId: data.proposedByUserId,
            orgId,
            proposedAt: now,
            status: "pending",
            conversionFactor: data.conversionFactor ?? 1,
          },
        });

        const orgItem = await tx.orgItem.create({
          data: { orgId, gtin13: data.provisionalGtin13, existingQuantity: 0, desiredQuantity: 0 },
        });

        await tx.inventoryLog.create({
          data: {
            orgId, userId: null, changedAt: now, changeType: "automatic",
            gtin13: data.provisionalGtin13, fieldChanged: "status",
            valueBefore: null, valueAfter: "pending", receiptId: data.receiptId,
          },
        });

        return { provisionalItem, orgItem };
      });

      // Reconcile-on-ingest (after commit, since it issues its own writes/merge): if a catalog
      // resolution for this provisional GTIN already arrived (event-before-row), apply it now.
      await provisionalItemService.reconcileProvisionalOnCreate(orgId, data.provisionalGtin13);

      return result;
    },

    async enqueueItem(
      orgId: string,
      data: {
        gtin13: string;
        quantity: number;
        retailer?: string;
        receiptId: string;
        lineItemId: number;
        conversionFactor?: number;
        conversionVersion?: number;
      },
    ) {
      return receiveQueueRepo.create({
        orgId,
        gtin13: data.gtin13,
        quantity: data.quantity,
        conversionFactor: data.conversionFactor ?? 1,
        conversionVersion: data.conversionVersion ?? 1,
        retailer: data.retailer ?? "",
        receiptId: data.receiptId,
        lineItemId: data.lineItemId,
        queuedAt: new Date(),
      });
    },
  };
}

export type ReceiptService = ReturnType<typeof createReceiptService>;
