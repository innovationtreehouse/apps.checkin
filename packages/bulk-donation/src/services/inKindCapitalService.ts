// A gift's capital decision, taken on its own lines after it is accepted: the expense library's two
// review steps bound to the gift's lines and history, and the drain's registration of each capital line.
import { ServiceError, kindOf } from "@checkin/component-kit";
import { db, type DbOrTx } from "../db";
import { bulkDonationRuntime, getInKindCapital, getOrgId } from "../runtime";
import { recordEvent } from "../repositories/audit";
import type { AuditContext } from "../workflows/disbursement.actor";
import type { CapitalDesignation, CapitalLineStore, CapitalPeriods } from "../contract";
import { bookedLines, capitalWaitsOn, loadGift, lockGift, type InKindSource } from "./inKindAcceptService";

type Actor = AuditContext & { actorUserId: number };
type Gift = NonNullable<Awaited<ReturnType<typeof loadGift>>>;

const REGISTER_ACTOR = { actorUserId: null, actorUsername: "system:in-kind-drain", correlationId: null };

/** The gift's audit entity: a receipt gift's receipt id, or a gift without one's own id. */
function entityOf(g: Pick<Gift, "source" | "id" | "receiptId">) {
  return g.source === "receipt"
    ? { entityType: "in_kind" as const, entityId: g.receiptId ?? String(g.id) }
    : { entityType: "manual_in_kind" as const, entityId: String(g.id) };
}

const LINE_REPLY_SELECT = {
  id: true,
  donationId: true,
  description: true,
  quantity: true,
  valueCents: true,
  isCapital: true,
  depreciationYears: true,
  capitalBucketId: true,
  capitalDecidedByUserId: true,
  capitalDecidedAt: true,
  registeredAt: true,
} as const;

async function writeLine(tx: DbOrTx, source: InKindSource, giftId: number, lineId: number, data: Record<string, unknown>) {
  const where = { id: lineId, donationId: giftId };
  if (source === "receipt") await tx.inKindDonationLine.updateMany({ where, data });
  else await tx.manualInKindDonationLine.updateMany({ where, data });
}

/** Binds the review to the gift's lines and its history, inside the gift's transaction. */
function giftLineStore(tx: DbOrTx, orgId: string, gift: Gift, actor: Actor): CapitalLineStore {
  return {
    async lines() {
      return gift.lines.map((l) => ({ id: l.id, isCapital: l.isCapital, ownerId: l.capitalBucketId, depreciationYears: l.depreciationYears }));
    },
    async save(step, line) {
      const data = step === "designated"
        ? { isCapital: line.isCapital, capitalBucketId: line.ownerId, depreciationYears: null, capitalDecidedByUserId: actor.actorUserId, capitalDecidedAt: new Date() }
        : { capitalBucketId: line.ownerId, depreciationYears: line.depreciationYears };
      await writeLine(tx, gift.source, gift.id, line.id, data);
      await recordEvent(tx, {
        orgId,
        ...entityOf(gift),
        eventType: step === "designated" ? "IN_KIND_CAPITAL_DESIGNATED" : "IN_KIND_CAPITAL_PERIOD_SET",
        ...actor,
        payload: { lineId: line.id, isCapital: line.isCapital, ownerId: line.ownerId, depreciationYears: line.depreciationYears },
      });
    },
    async afterStep() {},
  };
}

/** Locks the gift and returns it while its capital review waits on `step`; the step is taken once. */
async function lockForStep(tx: DbOrTx, orgId: string, source: InKindSource, id: number, step: "designation" | "period"): Promise<Gift> {
  await lockGift(tx, source, id);
  const gift = await loadGift(tx, orgId, source, id);
  if (!gift) throw new ServiceError(404, "In-kind gift not found");
  if (capitalWaitsOn(gift) !== "capital") throw new ServiceError(409, "This gift has no capital review waiting");
  const designated = gift.lines.every((l) => l.isCapital !== null);
  if (step === "designation" && designated) throw new ServiceError(409, "This gift's lines are already designated");
  if (step === "period" && !designated) throw new ServiceError(409, "Designate each line of this gift first");
  return gift;
}

async function replyLines(source: InKindSource, id: number) {
  const args = { where: { donationId: id }, select: LINE_REPLY_SELECT, orderBy: { id: "asc" as const } };
  return source === "receipt"
    ? { InKindDonationLine: await db.inKindDonationLine.findMany(args) }
    : { ManualInKindDonationLine: await db.manualInKindDonationLine.findMany(args) };
}

/** Finance designates every line of an accepted gift capital or not, with an owner for a capital line. */
async function designate(source: InKindSource, id: number, input: CapitalDesignation, actor: Actor) {
  const orgId = await getOrgId();
  await db.$transaction(async (tx) => {
    const gift = await lockForStep(tx, orgId, source, id, "designation");
    await getInKindCapital().review.designate(giftLineStore(tx, orgId, gift, actor), input);
  });
  return replyLines(source, id);
}

/** Finance sets each capital line's period and owner; the drain then registers its assets. */
async function setPeriod(source: InKindSource, id: number, input: CapitalPeriods, actor: Actor) {
  const orgId = await getOrgId();
  await db.$transaction(async (tx) => {
    const gift = await lockForStep(tx, orgId, source, id, "period");
    await getInKindCapital().review.setPeriod(giftLineStore(tx, orgId, gift, actor), input, async (_line, item) => {
      if (item.seededAssetNumbers) throw new ServiceError(400, "A gift's assets are given new numbers; only a backfilled expense links seeded ones");
    });
  });
  return replyLines(source, id);
}

/** Stamps the line registered under the gift's lock, once, naming its asset numbers. */
async function stamp(orgId: string, gift: Gift, lineId: number, assetNumbers: string[]): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockGift(tx, gift.source, gift.id);
    const where = { id: lineId, donationId: gift.id, isCapital: true, registeredAt: null };
    const data = { registeredAt: new Date() };
    const { count } = gift.source === "receipt" ? await tx.inKindDonationLine.updateMany({ where, data }) : await tx.manualInKindDonationLine.updateMany({ where, data });
    if (count === 0) return;
    await recordEvent(tx, { orgId, ...entityOf(gift), eventType: "IN_KIND_CAPITAL_REGISTERED", ...REGISTER_ACTOR, payload: { lineId, assetNumbers } });
  });
}

export interface RegisterCounts {
  registered: number;
  failed: number;
}

/**
 * Registers each capital line whose period is set and that has no asset numbers yet, then stamps
 * it. A crash between the two is safe: the register returns the same numbers on the next run.
 */
export async function registerCapitalLines(orgId: string): Promise<RegisterCounts> {
  const where = { isCapital: true, depreciationYears: { not: null }, registeredAt: null, donation: { orgId, decisionOutcome: "ACCEPTED" } };
  const select = { donationId: true } as const;
  const [receipts, manuals] = await Promise.all([
    db.inKindDonationLine.findMany({ where, select, distinct: ["donationId"] }),
    db.manualInKindDonationLine.findMany({ where, select, distinct: ["donationId"] }),
  ]);
  const pending: { source: InKindSource; id: number }[] = [
    ...receipts.map((r) => ({ source: "receipt" as const, id: r.donationId })),
    ...manuals.map((r) => ({ source: "manual" as const, id: r.donationId })),
  ];
  const counts: RegisterCounts = { registered: 0, failed: 0 };
  for (const { source, id } of pending) {
    try {
      const gift = await loadGift(db, orgId, source, id);
      if (!gift || capitalWaitsOn(gift) !== "register") continue;
      for (const { line, description, costCents } of bookedLines(gift)) {
        if (!line.isCapital || line.registeredAt || line.depreciationYears === null) continue;
        const assetNumbers = await getInKindCapital().register(orgId, {
          giftSource: source,
          giftId: id,
          giftLineId: line.id,
          description,
          costCents,
          quantity: line.quantity,
          acquisitionDate: gift.receiptDate ?? gift.donationDate,
          depreciationYears: line.depreciationYears,
        });
        await stamp(orgId, gift, line.id, assetNumbers);
        counts.registered++;
      }
    } catch (err) {
      console.warn(`[bulk-donation] registering ${source} gift ${id}'s capital lines failed (${kindOf(err)}); the next run tries again`);
      bulkDonationRuntime.failed("in-kind-capital-register", err, `${source} gift ${id}`);
      counts.failed++;
    }
  }
  return counts;
}

export const inKindCapitalService = { designate, setPeriod };
