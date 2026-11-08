import { ServiceError, type StuckItem } from "@checkin/component-kit";
import { db } from "./db";
import { getOrgId } from "./runtime";
import { IN_KIND_HELD_STATES, postGift } from "./lib/in-kind-poster";
import { openRun } from "./lib/in-kind-resolve";
import type { InKindSource } from "./services/inKindAcceptService";

const QB_POSTING = "QuickBooks posting";
const RETRY_ACTOR = { actorUserId: null, actorUsername: "system:problems-retry", correlationId: null };

/** In-kind gifts whose QuickBooks post failed, timed by their first failure. */
export async function stuckItems(): Promise<StuckItem[]> {
  const orgId = await getOrgId();
  const rows = await db.inKindPosting.findMany({
    where: { orgId, qbFirstFailedAt: { not: null }, matchState: { in: [...IN_KIND_HELD_STATES] } },
    select: { source: true, giftId: true, qbFirstFailedAt: true },
  });
  return rows.flatMap((r) => (r.qbFirstFailedAt ? [{ id: `${r.source} ${r.giftId}`, step: QB_POSTING, href: `/donations/in-kind/${r.source}/${r.giftId}`, failedAt: r.qbFirstFailedAt }] : []));
}

/**
 * Posts the stuck gift once, as the drain would. Safe to repeat: the claim and the look-up of the
 * gift's own entry by key hold. A post that fails again keeps the first failure time; a gift that
 * is not stuck answers 404.
 */
export async function retryStuckItem({ id, step }: { id: string; step: string }): Promise<void> {
  const [source, giftId] = id.split(" ");
  const orgId = await getOrgId();
  const stuck =
    step === QB_POSTING && (source === "receipt" || source === "manual") &&
    (await db.inKindPosting.findFirst({ where: { orgId, source, giftId: Number(giftId) || -1, qbFirstFailedAt: { not: null }, matchState: { in: [...IN_KIND_HELD_STATES] } }, select: { id: true } }));
  if (!stuck) throw new ServiceError(404, `No failed ${step} for ${id} in gifts`);
  const outcome = await postGift(await openRun(orgId, RETRY_ACTOR, "retry"), source as InKindSource, Number(giftId));
  if (outcome === "not_ready") throw new ServiceError(409, "This gift waits on more than booking");
  if (outcome === "busy") throw new ServiceError(409, "The gift is being posted; try again shortly");
}
