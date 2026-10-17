import type { OrgMembershipProcess, OrgMembershipProcessStatus } from "@/generated/prisma/client";
import { IN_FLIGHT_INITIAL } from "@/lib/membership/lifecycle";

/**
 * Applicant-facing phases of an INITIAL membership application, in order.
 * Drives the left-rail flow diagram (MembershipFlowStepper) and lets the API
 * report "where am I?" without leaking internal mechanics.
 *
 * The background check is NOT a sequential phase here — it runs as a parallel
 * track (consent in the Contract & Background Check step, then review in the
 * background) and only gates the final ACTIVE transition. PENDING_BG_CLEARANCE
 * (paid, awaiting the check) and BLOCKED are off-track states handled separately
 * (never shown as their own step).
 */
export interface IntakePhase {
    status: OrgMembershipProcessStatus;
    label: string;
    description: string;
}

export const INITIAL_PHASES: IntakePhase[] = [
    { status: "INTAKE", label: "Your Family", description: "Tell us about your household." },
    { status: "PENDING_EXTERNAL_ACTION", label: "Contract & Background Check", description: "Sign the contract and start your background check." },
    { status: "PENDING_PAYMENT", label: "Payment", description: "Pay your annual membership fee." },
    { status: "ACTIVE", label: "Member", description: "Welcome to the Treehouse!" },
];

/**
 * Stepper position for a status: how many INITIAL_PHASES steps are complete.
 * PENDING_BG_CLEARANCE (paid, awaiting the check) sits between Payment and
 * Member — payment shows complete, Member is the pending current step. BLOCKED
 * and other off-track statuses return -1 (handled with an inline alert).
 */
export function stepperActiveIndex(status: OrgMembershipProcessStatus | null): number {
    switch (status) {
        case "INTAKE": return 0;
        case "PENDING_EXTERNAL_ACTION": return 1;
        // Legacy held-for-review rows: external actions are done, Payment pending.
        case "PENDING_BG_REVIEW": return 2;
        case "PENDING_PAYMENT": return 2;
        case "PENDING_BG_CLEARANCE": return 3;
        case "ACTIVE": return 4;
        default: return -1;
    }
}

/**
 * Statuses where an INITIAL application is still open (work remains). The list
 * itself is now defined ONCE in lib/membership/lifecycle (`IN_FLIGHT_INITIAL`,
 * fix #2) — the single source the `membership_one_inflight_initial` partial index
 * is verified against. This is a back-compat mutable alias for existing consumers
 * (intake.ts, the intakeConcurrency suite) that pass it straight to Prisma's `in`.
 */
export const IN_FLIGHT_INITIAL_STATUSES: OrgMembershipProcessStatus[] = [...IN_FLIGHT_INITIAL];

/**
 * The latest process awaiting applicant external action (contract signing).
 * Kind-agnostic by design — INITIAL applications AND renewals both re-sign here,
 * and gating on status alone keeps the sign button (getOrCreateContractSigningUrl)
 * in step with the status sync (syncContractStatus); a kind filter would render
 * the button then 409. Highest id == most recent (autoincrement). Returns
 * undefined when nothing is awaiting action — callers guard for that.
 */
export function latestPendingExternal<T extends Pick<OrgMembershipProcess, "id" | "status">>(
    processes: T[] | null | undefined,
): T | undefined {
    return [...(processes ?? [])]
        .filter((p) => p.status === "PENDING_EXTERNAL_ACTION")
        .sort((a, b) => b.id - a.id)[0];
}
