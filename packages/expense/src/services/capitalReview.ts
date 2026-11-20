// Capital review's two steps, designate then period and owner, for any record whose lines carry a
// capital decision. The record binds a CapitalLineStore inside its own transaction.
import { z } from "zod";
import { ServiceError } from "@checkin/component-kit";
import { requireLiveBuckets } from "./approvalService";

export const CapitalReviewSchema = z.object({
  lineItems: z
    .array(
      z.object({
        lineItemId: z.number().int().positive(),
        isCapital: z.boolean(),
        capitalOwnerId: z.number().int().positive().nullable().optional(),
        depreciationYears: z.number().int().positive().nullable().optional(),
      }).strict(),
    )
    .min(1),
}).strict();

export const SetDepreciationCycleSchema = z.object({
  items: z
    .array(
      z.object({
        lineItemId: z.number().int().positive(),
        depreciationYears: z.number().int().positive(),
        ownerId: z.number().int().positive(),
        // A backfilled expense's historical labels, one per unit in unit order.
        seededAssetNumbers: z.array(z.string().min(1).max(20)).min(1).max(1000).optional(),
      }),
    )
    .min(1),
});

export type CapitalReviewInput = z.infer<typeof CapitalReviewSchema>;
export type SetDepreciationCycleInput = z.infer<typeof SetDepreciationCycleSchema>;
export type PeriodItem = SetDepreciationCycleInput["items"][number];

/** A line's capital decision: null until designated; years only on a capital line. */
export interface CapitalLine {
  id: number;
  isCapital: boolean | null;
  ownerId: number | null;
  depreciationYears: number | null;
}

/** A line as either step saves it: designated. */
export type DecidedLine = CapitalLine & { isCapital: boolean };

export type CapitalStep = "designated" | "period_set";

export interface CapitalLineStore {
  lines(): Promise<CapitalLine[]>;
  /** Writes the line and its audit row for the step. */
  save(step: CapitalStep, line: DecidedLine, before: CapitalLine): Promise<void>;
  /** Runs once every line of the step is saved. */
  afterStep(step: CapitalStep): Promise<void>;
}

/** Registers a capital line's assets once its period is set, in the step's transaction. */
export type RegisterCall = (line: DecidedLine, item: PeriodItem) => Promise<void>;

/** What a record's capital review waits on, read from its lines; null when it is done. */
export function capitalWaitsOn(lines: CapitalLine[]): "designation" | "period" | null {
  if (lines.some((l) => l.isCapital === null)) return "designation";
  if (lines.some((l) => l.isCapital && l.depreciationYears === null)) return "period";
  return null;
}

/** Designates every line of the record capital or not, with an owner for a capital line. */
export async function designate(store: CapitalLineStore, input: CapitalReviewInput): Promise<void> {
  const lines = new Map((await store.lines()).map((l) => [l.id, l]));
  const submittedIds = new Set(input.lineItems.map((li) => li.lineItemId));
  for (const id of lines.keys()) {
    if (!submittedIds.has(id)) throw new ServiceError(400, `Missing designation for line item ${id}`);
  }
  for (const li of input.lineItems) {
    if (!lines.has(li.lineItemId)) throw new ServiceError(400, `Line item ${li.lineItemId} is not on this record`);
  }
  await requireLiveBuckets(input.lineItems.flatMap((li) => (li.isCapital && li.capitalOwnerId != null ? [li.capitalOwnerId] : [])));

  for (const li of input.lineItems) {
    const before = lines.get(li.lineItemId)!;
    await store.save("designated", {
      ...before,
      isCapital: li.isCapital,
      ownerId: li.isCapital ? (li.capitalOwnerId ?? null) : null,
      depreciationYears: null,
    }, before);
  }
  await store.afterStep("designated");
}

/** Sets each capital line's period and owner, and registers its assets. */
export async function setPeriod(store: CapitalLineStore, input: SetDepreciationCycleInput, register: RegisterCall): Promise<void> {
  const capital = new Map((await store.lines()).filter((l) => l.isCapital).map((l) => [l.id, l]));
  const submittedIds = new Set(input.items.map((i) => i.lineItemId));
  for (const id of capital.keys()) {
    if (!submittedIds.has(id)) throw new ServiceError(400, `Missing depreciation for capital line item ${id}`);
  }
  for (const item of input.items) {
    if (!capital.has(item.lineItemId)) throw new ServiceError(400, `Line item ${item.lineItemId} is not a capital item`);
  }
  await requireLiveBuckets(input.items.map((i) => i.ownerId));

  for (const item of input.items) {
    const before = capital.get(item.lineItemId)!;
    const line = { ...before, isCapital: true, depreciationYears: item.depreciationYears, ownerId: item.ownerId };
    await store.save("period_set", line, before);
    await register(line, item);
  }
  await store.afterStep("period_set");
}
