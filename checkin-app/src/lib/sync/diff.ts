import type { ListIntent, ListTargetKind } from "@/generated/prisma/client";
import { canonicalizeEmail } from "@/lib/emailNormalize";
import type { DesiredMember } from "./desiredState";

/** A ListSyncState row, or (personId null) a ProgramExternalContact keyed by its email. */
export type LedgerRow = {
    personId: number | null;
    appliedEmail: string | null;
    appliedAt: Date | null;
    lastIntent: ListIntent | null;
};

export type TargetPlan = {
    /** Apply before removes, so a shared address never drops off transiently. */
    adds: { personId: number | null; email: string; reasons: string[] }[];
    removes: { email: string }[];
    /** Desired, present externally, no applied ledger row: write the row, call nothing. */
    adopts: { personId: number | null; email: string }[];
    /** Desired and present, but the person's row is applied under another address: re-point it. */
    rebinds: { personId: number; email: string }[];
    /** Present externally, neither desired nor applied by us: reported, never removed. */
    ghosts: string[];
};

const key = canonicalizeEmail;

/** Email-level plan for one list (design sections 2.2, 4, 7.1). Pure. */
export function planTarget(
    desired: { targetKind: ListTargetKind; members: DesiredMember[] },
    observedEmails: string[],
    ledger: LedgerRow[],
): TargetPlan {
    const observed = new Map<string, string>();
    for (const e of observedEmails) if (!observed.has(key(e))) observed.set(key(e), e);

    const rowOf = new Map(ledger.filter((r) => r.personId !== null).map((r) => [r.personId, r]));
    const extOf = new Map(ledger.filter((r) => r.personId === null && r.appliedEmail).map((r) => [key(r.appliedEmail!), r]));
    const ledgerOf = (m: DesiredMember) => (m.personId === null ? extOf.get(key(m.email)) : rowOf.get(m.personId));
    const outOf = (m: DesiredMember) => ledgerOf(m)?.lastIntent === "OUT";

    const wanted = new Map<string, DesiredMember[]>();
    for (const m of desired.members) {
        if (outOf(m)) continue;
        const k = key(m.email);
        wanted.set(k, [...(wanted.get(k) ?? []), m]);
    }

    const plan: TargetPlan = { adds: [], removes: [], adopts: [], rebinds: [], ghosts: [] };
    for (const [k, members] of wanted) {
        if (!observed.has(k)) {
            plan.adds.push({
                personId: members.find((m) => m.personId !== null)?.personId ?? null,
                email: members[0].email,
                reasons: [...new Set(members.flatMap((m) => m.reasons))],
            });
            continue;
        }
        for (const m of members) {
            const row = ledgerOf(m);
            if (!row?.appliedAt) plan.adopts.push({ personId: m.personId, email: observed.get(k)! });
            else if (m.personId !== null && (!row.appliedEmail || key(row.appliedEmail) !== k)) plan.rebinds.push({ personId: m.personId, email: observed.get(k)! });
        }
    }

    for (const [k, email] of observed) {
        if (wanted.has(k)) continue;
        const applied = ledger.filter((r) => r.appliedAt && r.appliedEmail && key(r.appliedEmail) === k);
        if (applied.length === 0) plan.ghosts.push(email);
        // The newsletter removes only on the person's own OUT.
        else if (desired.targetKind !== "NEWSLETTER" || applied.every((r) => r.lastIntent === "OUT")) plan.removes.push({ email });
    }
    return plan;
}
