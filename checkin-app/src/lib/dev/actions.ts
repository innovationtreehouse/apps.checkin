"use server";

import { revalidatePath } from "next/cache";
import prisma from "@/lib/prisma";
import { assertDevActor } from "@/lib/dev/guard";
import { recordLedger, recentActivity, type LedgerEntry } from "@/lib/dev/ledger";
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

// ── Reset (truncate + reseed; docs/ops/dev-instance.md, "Reset") ────────────
export async function resetDevInstance(): Promise<ActionResult> {
    const real = await assertDevActor();

    // 1. Truncate every application table in one statement — schema-drift-proof: the list is read
    //    from the catalog at runtime, so new models are picked up automatically and we never hand-
    //    maintain it. _prisma_migrations is preserved (schema stays migrated — no re-migration, so
    //    this is seconds not minutes); DevLedger is preserved so the coordination history survives.
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN ('_prisma_migrations', 'DevLedger')
    `;
    const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
    if (tables) {
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;`);
    }

    // 2. Repopulate the standard personas + tools + sample program.
    await seedBaseline(prisma);

    // 3. Record the reset (after reseed so the ledger row survives) and refresh the UI.
    await recordLedger("reset", real);
    revalidatePath("/", "layout");
    return { ok: true, summary: "Dev instance reset to baseline" };
}

// ── Ledger reader (for the dashboard activity line + reset confirm dialog) ──
export async function getRecentActivity(limit = 5): Promise<LedgerEntry[]> {
    await assertDevActor();
    return recentActivity(limit);
}
