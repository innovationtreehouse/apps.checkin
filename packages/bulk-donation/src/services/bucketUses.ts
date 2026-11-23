import { db } from "../db";
import { getIncomeDeposits, getOrgId } from "../runtime";
import { depositSendable } from "../lib/deposit-handover";
import { unbookedGiftsIn } from "./inKindAcceptService";

/** One kind of unfinished work that still needs a bucket, in finance's words, with the page finance moves it from. */
export interface BucketUse {
  what: string;
  count: number;
  where: string;
}

/** The disbursements in `ids` income has not taken yet; one income will never be handed counts as taken. */
async function notHandedOver(orgId: string, ids: string[]): Promise<Set<string>> {
  const completed = new Set(
    (await db.disbursementEvent.findMany({ where: { orgId, disbursementId: { in: ids } }, select: { disbursementId: true } })).map((e) => e.disbursementId),
  );
  const deposits = getIncomeDeposits();
  const handOver = ids.filter((id) => completed.has(id) && (!deposits || depositSendable(deposits, id)));
  const known = deposits && handOver.length ? await deposits.depositStatus(orgId, handOver) : {};
  return new Set(ids.filter((id) => !completed.has(id) || (handOver.includes(id) && !known[id])));
}

/**
 * What in the bulk-donation library still needs bucket `id`, one line per kind; empty when nothing
 * does. A Benevity gift counts until income takes its disbursement, which then counts it itself.
 * Comment rules don't count: an upload skips a rule whose bucket is archived.
 */
export async function unfinishedBucketUses(id: number): Promise<BucketUse[]> {
  const orgId = await getOrgId();
  const capitalLines = { capitalBucketId: id, isCapital: true, registeredAt: null, donation: { orgId, decisionOutcome: "ACCEPTED" } };
  const [gifts, goods, receiptCapital, manualCapital] = await Promise.all([
    db.transaction.findMany({ where: { orgId, ownerId: id, feeReleasedAt: null }, select: { disbursementId: true } }),
    unbookedGiftsIn(id),
    db.inKindDonationLine.count({ where: capitalLines }),
    db.manualInKindDonationLine.count({ where: capitalLines }),
  ]);
  const disbursements = [...new Set(gifts.flatMap((g) => (g.disbursementId ? [g.disbursementId] : [])))];
  const waiting = await notHandedOver(orgId, disbursements);
  const undeposited = gifts.filter((g) => !g.disbursementId || waiting.has(g.disbursementId)).length;
  return [
    { what: "Benevity gifts not yet deposited", count: undeposited, where: "Donations › Gifts" },
    { what: "gifts of goods not yet booked", count: goods, where: "Donations › Queue" },
    { what: "donated capital lines without asset numbers", count: receiptCapital + manualCapital, where: "Donations › Queue" },
  ].filter((use) => use.count > 0);
}
