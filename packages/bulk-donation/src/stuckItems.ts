import { ServiceError, type StuckItem } from "@checkin/component-kit";
import { THROTTLED_MESSAGE } from "@checkin/quickbooks";
import { db } from "./db";
import { getOrgId } from "./runtime";
import { IN_KIND_HELD_STATES, postGift, type InKindPostOutcome } from "./lib/in-kind-poster";
import { openRun } from "./lib/in-kind-resolve";
import type { InKindSource } from "./services/inKindAcceptService";
import { inKindRegistration } from "./services/inKindCapitalService";

const QB_POSTING = "QuickBooks posting";
const CAPITAL_REGISTRATION = "capital asset registration";
const RETRY_ACTOR = { actorUserId: null, actorUsername: "system:problems-retry", correlationId: null };
/** What a retry that did not reach the books answers; the error itself stays on the gift's own page. */
const NOT_POSTED = "Retried, and it was not posted; the gift's page shows why";
const RETRY_REFUSALS: Record<Exclude<InKindPostOutcome, "posted" | "matched"> | "not_ready" | "busy", [number, string]> = {
  failed: [503, "Retried, and it failed again; the gift's page shows why"],
  throttled: [503, `Not retried: ${THROTTLED_MESSAGE}`],
  waiting: [409, NOT_POSTED],
  unbooked: [409, NOT_POSTED],
  needs_finance: [409, NOT_POSTED],
  held: [409, NOT_POSTED],
  not_ready: [409, "This gift waits on more than booking"],
  busy: [409, "The gift is being posted; try again shortly"],
};

const giftHref = (source: string, giftId: number) => `/donations/in-kind/${source}/${giftId}`;

/** In-kind gifts whose QuickBooks post or capital asset registration failed, timed by their first failure. */
export async function stuckItems(): Promise<StuckItem[]> {
  const orgId = await getOrgId();
  const [rows, registrations] = await Promise.all([
    db.inKindPosting.findMany({
      where: { orgId, qbFirstFailedAt: { not: null }, matchState: { in: [...IN_KIND_HELD_STATES] } },
      select: { source: true, giftId: true, qbFirstFailedAt: true },
    }),
    inKindRegistration.stuckRegistrations(orgId),
  ]);
  return [
    ...rows.flatMap((r) => (r.qbFirstFailedAt ? [{ id: `${r.source} ${r.giftId}`, step: QB_POSTING, href: giftHref(r.source, r.giftId), failedAt: r.qbFirstFailedAt }] : [])),
    ...registrations.map((g) => ({ id: `${g.source} ${g.id}`, step: CAPITAL_REGISTRATION, href: giftHref(g.source, g.id), failedAt: g.failedAt })),
  ];
}

/**
 * Retries the stuck gift's step once. A posting retry posts as the drain would, safe to repeat because
 * the claim and the look-up of the gift's own entry by key hold. Returns only when the step succeeded;
 * any other outcome answers an error that carries no error text and keeps the first failure time.
 * A gift that is not stuck at that step answers 404.
 */
export async function retryStuckItem({ id, step }: { id: string; step: string }): Promise<void> {
  const [source, giftId] = id.split(" ");
  const orgId = await getOrgId();
  if (step === CAPITAL_REGISTRATION) return retryRegistration(orgId, source, Number(giftId), id);
  const stuck =
    step === QB_POSTING && (source === "receipt" || source === "manual") &&
    (await db.inKindPosting.findFirst({ where: { orgId, source, giftId: Number(giftId) || -1, qbFirstFailedAt: { not: null }, matchState: { in: [...IN_KIND_HELD_STATES] } }, select: { id: true } }));
  if (!stuck) throw new ServiceError(404, `No failed ${step} for ${id} in gifts`);
  const outcome = await postGift(await openRun(orgId, RETRY_ACTOR, "retry"), source as InKindSource, Number(giftId));
  if (outcome === "posted" || outcome === "matched") return;
  const [status, message] = RETRY_REFUSALS[outcome] ?? [409, NOT_POSTED];
  throw new ServiceError(status, message);
}

/** Registers the stuck gift's capital lines once; the register returns the same numbers for a line, so a repeat is safe. */
async function retryRegistration(orgId: string, source: string, giftId: number, id: string): Promise<void> {
  const outcome = source === "receipt" || source === "manual" ? await inKindRegistration.retryRegistration(orgId, source, giftId || -1) : "not_stuck";
  if (outcome === "registered") return;
  if (outcome === "not_stuck") throw new ServiceError(404, `No failed ${CAPITAL_REGISTRATION} for ${id} in gifts`);
  if (outcome === "system" || outcome === "connection") throw new ServiceError(503, "Retried, and the capital register could not be reached");
  throw new ServiceError(409, "Retried, and the capital register did not take the gift's lines");
}
