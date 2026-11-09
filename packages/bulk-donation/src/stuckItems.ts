import { ServiceError, type StuckItem } from "@checkin/component-kit";
import { db } from "./db";
import { getOrgId } from "./runtime";
import { IN_KIND_HELD_STATES, postGift, type InKindPostOutcome } from "./lib/in-kind-poster";
import { openRun } from "./lib/in-kind-resolve";
import type { InKindSource } from "./services/inKindAcceptService";

const QB_POSTING = "QuickBooks posting";
const RETRY_ACTOR = { actorUserId: null, actorUsername: "system:problems-retry", correlationId: null };
/** What a retry that did not reach the books answers; the error itself stays on the gift's own page. */
const NOT_POSTED = "Retried, and it was not posted; the gift's page shows why";
const RETRY_REFUSALS: Record<Exclude<InKindPostOutcome, "posted" | "matched"> | "not_ready" | "busy", [number, string]> = {
  failed: [503, "Retried, and it failed again; the gift's page shows why"],
  waiting: [409, NOT_POSTED],
  unbooked: [409, NOT_POSTED],
  needs_finance: [409, NOT_POSTED],
  held: [409, NOT_POSTED],
  not_ready: [409, "This gift waits on more than booking"],
  busy: [409, "The gift is being posted; try again shortly"],
};

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
 * gift's own entry by key hold. Returns only when the gift reached the books; any other outcome
 * answers an error that carries no error text and keeps the first failure time. A gift that is not
 * stuck answers 404.
 */
export async function retryStuckItem({ id, step }: { id: string; step: string }): Promise<void> {
  const [source, giftId] = id.split(" ");
  const orgId = await getOrgId();
  const stuck =
    step === QB_POSTING && (source === "receipt" || source === "manual") &&
    (await db.inKindPosting.findFirst({ where: { orgId, source, giftId: Number(giftId) || -1, qbFirstFailedAt: { not: null }, matchState: { in: [...IN_KIND_HELD_STATES] } }, select: { id: true } }));
  if (!stuck) throw new ServiceError(404, `No failed ${step} for ${id} in gifts`);
  const outcome = await postGift(await openRun(orgId, RETRY_ACTOR, "retry"), source as InKindSource, Number(giftId));
  if (outcome === "posted" || outcome === "matched") return;
  const [status, message] = RETRY_REFUSALS[outcome] ?? [409, NOT_POSTED];
  throw new ServiceError(status, message);
}
