import { calculateAge } from "@/lib/time";

/**
 * ┌─ 18+ program-people background-check POLICY (board-decided; not inferable from code) ─┐
 * These are the rules the feature encodes. They are policy, not implementation detail —
 * change them only with the board.
 *
 *  • Subject = program-attached people ≥18: ProgramParticipant ∪ ProgramVolunteer ∪
 *    Program.leadMentor. (Volunteers who are household leads are already checked via the
 *    household flow — this is the non-lead / aged-up gap.)
 *  • Age is judged AS-OF the membership-year boundary (orgMembershipYearBoundary), boundary
 *    INCLUSIVE (an 18th birthday landing on it counts as ≥18). NOT as-of "now" or a role
 *    change: someone who turns 18 after the boundary waits for the next one (Nov-1 birthday +
 *    Nov-15 role → next Sept-1, not now).
 *  • ≥18 is a HARD floor. Under-18 volunteers ("young adult mentors") are never checked — a
 *    minor cannot be background-checked. Unknown age (no DOB, not declared-adult) is a
 *    data-hygiene item, NEVER auto-checked and NEVER treated as cleared.
 *  • Checks are PER-ADULT. One person's check must never satisfy another's — in particular a
 *    household lead's check does not cover a second volunteering spouse. Both paths obey this:
 *    PERSON_BG stamps its subject, and the household clearance stamps only the adults the
 *    reviewers named off the Averity reports.
 *  • Posture is WARN-ONLY. An un-cleared obligation never blocks participation/check-in/renewal.
 *  • Consent for the (manual) path is IMPLICIT in the self-initiated external check; the board/
 *    lead submits "a check exists, review it". No in-app consent orchestration was shipped.
 *  • Recheck window = BoardSettings.bgRecheckMonths (same knob as household leads). When 0 the
 *    policy is UNSET — treat as "do not enforce", never as "everyone is stale".
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Per-person background-check verdict for the board compliance dashboard
 * (Phase 1 — warn-only, read-only). Generalizes householdBgIsFresh from
 * "any household lead is fresh" to "this specific person is fresh".
 *
 *   NEEDED      — ≥18 (as of the boundary) and NOT background-checked recently.
 *   FRESH       — check still valid at the boundary; already covered.
 *   MINOR       — under 18 as of the boundary; a minor cannot be checked.
 *   DOB_MISSING — no DOB and not declared 25+; age unknown, so we can neither
 *                 confirm ≥18 nor treat them as cleared. A data-hygiene item,
 *                 NOT a bg-needed item (never auto-check a possible minor).
 */
export type PersonBgVerdict = "NEEDED" | "FRESH" | "MINOR" | "DOB_MISSING";

/**
 * Freshness cutoff: boundary minus recheckMonths. Mirrors monthsBefore() in
 * renewal.ts (UTC month math) so per-person freshness matches householdBgIsFresh.
 */
export function bgFreshThreshold(boundary: Date, recheckMonths: number): Date {
    const d = new Date(boundary);
    d.setUTCMonth(d.getUTCMonth() - recheckMonths);
    return d;
}

/**
 * Classify one program-attached person. `boundary` is the annual membership
 * boundary — age is judged as-of it (inclusive: an 18th birthday landing exactly
 * on the boundary counts as ≥18). `threshold` is bgFreshThreshold(boundary, months).
 */
export function personBgVerdict(
    person: { dateOfBirth: Date | null; isDeclaredAdult: boolean; lastBackgroundCheck: Date | null },
    boundary: Date,
    threshold: Date,
): PersonBgVerdict {
    // Unknown age — cannot confirm ≥18, must not be treated as cleared.
    if (!person.dateOfBirth && !person.isDeclaredAdult) return "DOB_MISSING";

    // isDeclaredAdult = "25+, no DOB recorded" → definitely ≥18.
    const isAdult = person.isDeclaredAdult || calculateAge(person.dateOfBirth!, boundary) >= 18;
    if (!isAdult) return "MINOR";

    if (person.lastBackgroundCheck && person.lastBackgroundCheck >= threshold) return "FRESH";
    return "NEEDED";
}
