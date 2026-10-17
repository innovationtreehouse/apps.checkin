/**
 * Lambda entry for admin operations. Invoke-only (no public endpoint, no schedule);
 * see FUTUREWORK.md in s-read-function for the IAM-gated security model.
 *
 *   { "mode": "replay", "objectType": "ORDER", "since": "2026-01-01T00:00:00Z",
 *     "actor": "ops:jane", "reason": "reproject after refund-normalization fix" }
 *   { "mode": "reset-watermark", "objectType": "PAYOUT", "to": null,
 *     "actor": "ops:jane", "reason": "force re-pull of payouts after schema change" }
 *   { "mode": "reingest-bulk", "since": "2026-01-01T00:00:00Z",
 *     "actor": "ops:jane", "reason": "repair backfill after reassembly fix" }
 *   { "mode": "replay", "scope": "all",
 *     "actor": "ops:jane", "reason": "full rebuild of every object type's projection" }
 *
 * A call with none of its mode's narrowing filters (replay: objectType/gid/since;
 * reset-watermark: objectType; reingest-bulk: since/bulkOperationId) acts on the whole
 * store, so it is refused unless it says `"scope": "all"`.
 *
 * The store defaults to STORE_ID from the environment but should normally be named
 * explicitly in the event.
 */
import { z } from "zod";
import { prisma, loadDbConfig, ObjectType, logger, ConcurrentRunError } from "@checkin/s-ingest-core";
import { replay, resetWatermark, reingestBulk } from "./replay.js";

// The filters that keep each mode from acting on the whole store.
const NARROWING_FILTERS = {
  replay: ["objectType", "gid", "since"],
  "reset-watermark": ["objectType"],
  "reingest-bulk": ["since", "bulkOperationId"],
} as const;

/**
 * The admin invocation contract. Validated with Zod at the boundary because the Lambda
 * event is an external, operator-controlled input. `actor` and `reason` are REQUIRED: these
 * are powerful, financially-relevant operations (replay re-projects history; reset-watermark
 * can force a full re-pull), so every invocation must record who ran it and why for audit.
 */
export const AdminEventSchema = z
  .object({
    mode: z.enum(["replay", "reset-watermark", "reingest-bulk"]),
    storeId: z.string().min(1).optional(),
    objectType: z.enum(["ORDER", "PAYOUT", "BALANCE_TXN", "REFUND"]).optional(),
    gid: z.string().min(1).optional(),
    // replay: occurredAt floor. reingest-bulk: export fetchedAt floor.
    since: z.string().datetime({ message: "since must be an ISO-8601 timestamp" }).optional(),
    to: z.string().datetime({ message: "to must be an ISO-8601 timestamp" }).nullish(), // reset-watermark only
    bulkOperationId: z.string().min(1).optional(), // reingest-bulk only
    actor: z.string().min(1, "actor is required (who is running this admin op)"),
    reason: z.string().min(1, "reason is required (why this admin op is being run)"),
    scope: z.literal("all").optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const filters = NARROWING_FILTERS[e.mode];
    if (e.scope === "all" || filters.some((f) => e[f] !== undefined)) return;
    ctx.addIssue({
      code: "custom",
      path: ["scope"],
      message: `${e.mode} with none of ${filters.join(", ")} acts on the whole store; pass one of those filters or "scope": "all"`,
    });
  });

export type AdminEvent = z.infer<typeof AdminEventSchema>;

export async function handler(event: unknown): Promise<Record<string, unknown>> {
  const parsed = AdminEventSchema.parse(event);
  const storeId = parsed.storeId ?? loadDbConfig().storeId;
  // Prisma enum values equal these literal strings, so the validated literal casts directly.
  const objectType = parsed.objectType ? (ObjectType[parsed.objectType] as ObjectType) : undefined;

  // Admin ops share the per-store run lock with scheduled syncs (withSyncRun): a replay or
  // reset must never run concurrently with an incremental/backfill for the same store. If the
  // lock is held, surface a clear "retry shortly" rather than corrupting state.
  try {
    switch (parsed.mode) {
      case "replay":
        return await replay(prisma, {
          storeId,
          objectType,
          gid: parsed.gid,
          sinceOccurredAt: parsed.since ? new Date(parsed.since) : undefined,
          actor: parsed.actor,
          reason: parsed.reason,
        });
      case "reset-watermark":
        return await resetWatermark(prisma, {
          storeId,
          objectType,
          to: parsed.to ? new Date(parsed.to) : null,
          actor: parsed.actor,
          reason: parsed.reason,
        });
      case "reingest-bulk":
        return await reingestBulk(prisma, {
          storeId,
          sinceFetchedAt: parsed.since ? new Date(parsed.since) : undefined,
          bulkOperationId: parsed.bulkOperationId,
          actor: parsed.actor,
          reason: parsed.reason,
        });
    }
  } catch (err) {
    if (err instanceof ConcurrentRunError) {
      logger.warn("admin op skipped: another run is already in progress for this store", {
        storeId,
        mode: parsed.mode,
        actor: parsed.actor,
      });
      return {
        skipped: true,
        mode: parsed.mode,
        reason: "another sync run is already in progress for this store; retry shortly",
      };
    }
    throw err;
  }
  // AdminEventSchema constrains mode to the three handled cases; this is unreachable.
  throw new Error(`unhandled admin mode: ${String(parsed.mode)}`);
}
