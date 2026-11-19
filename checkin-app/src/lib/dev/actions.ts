"use server";

import { revalidatePath } from "next/cache";
import prisma from "@/lib/prisma";
import { assertDevActor } from "@/lib/dev/guard";
import { truncateDevDatabases } from "@/lib/dev/reset";
import { recordLedger, recentActivity, type LedgerEntry } from "@/lib/dev/ledger";
import { DevLinkError, linkDevExternalIds } from "@/lib/dev/link";
import {
    seedBaseline,
    createFamily,
    createProgram,
    createEvent,
    createCheckins,
} from "@/lib/dev/seed-helpers";

/**
 * The dev dashboard's server actions (docs/ops/dev-instance.md, "The dev dashboard"). Every export is fenced by
 * assertDevActor() — dead in prod, org-verified in dev, relaxed on local — so the client can never
 * reach these in production and an unverified visitor can never drive them. Each mutating action
 * writes a ledger row (attributed to the real human) and revalidates the layout so the UI reflects
 * the new data.
 */

export type ActionResult = { ok: true; summary: string };
/** A reset whose link step failed: the databases are reseeded, the external ids are not. */
export type ResetResult = ActionResult | { ok: false; error: string };

// ── Macros (additive scenario seeders) ─────────────────────────────────────
async function runMacro(kind: string, fn: (db: typeof prisma) => Promise<string>): Promise<ActionResult> {
    const real = await assertDevActor();
    const summary = await fn(prisma);
    await recordLedger(`macro:${kind}`, real, summary);
    revalidatePath("/", "layout");
    return { ok: true, summary };
}

export async function macroFamily(): Promise<ActionResult> {
    return runMacro("family", createFamily);
}
export async function macroProgram(): Promise<ActionResult> {
    return runMacro("program", createProgram);
}
export async function macroEvent(): Promise<ActionResult> {
    return runMacro("event", createEvent);
}
export async function macroCheckins(): Promise<ActionResult> {
    return runMacro("checkins", createCheckins);
}

// ── Reset (truncate every database + reseed + link; docs/ops/dev-instance.md, "Reset") ──
export async function resetDevInstance(): Promise<ResetResult> {
    const real = await assertDevActor();

    let detail: string | null = null;
    try {
        const { skipped } = await truncateDevDatabases(prisma, () => seedBaseline(prisma));
        if (skipped.length) detail = `not configured: ${skipped.join(", ")}`;
    } catch (e) {
        await recordLedger("reset", real, `failed: ${e instanceof Error ? e.message : String(e)}`);
        revalidatePath("/", "layout");
        throw e;
    }

    // A link failure is returned, not thrown, because a production build hides a thrown server-action message.
    let linked: string;
    try {
        linked = await linkDevExternalIds();
    } catch (err) {
        if (!(err instanceof DevLinkError)) throw err;
        await recordLedger("reset", real, [detail, `Link failed: ${err.message}`].filter(Boolean).join("; "));
        revalidatePath("/", "layout");
        return { ok: false, error: err.message };
    }

    await recordLedger("reset", real, [detail, linked].filter(Boolean).join("; "));
    revalidatePath("/", "layout");
    return { ok: true, summary: `Dev instance reset to baseline. ${linked}` };
}

// ── Ledger reader (for the dashboard activity line + reset confirm dialog) ──
export async function getRecentActivity(limit = 5): Promise<LedgerEntry[]> {
    await assertDevActor();
    return recentActivity(limit);
}
