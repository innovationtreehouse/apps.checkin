// Pure helpers for the multi-select household enrollment flow on
// programs/[id]/page.tsx. Extracted so the money-path logic — 409-as-success
// idempotency, per-member error aggregation, and the Shopify cart assembly —
// is unit-testable without rendering the page. The page imports both; tests in
// __tests__/enroll.test.ts exercise them directly.

export type EnrollOutcome = {
    participantId: number;
    ok: boolean;
    status: number;
    error?: string;
    requiresOverride?: boolean;
};

/**
 * Fold per-participant POST outcomes into the aggregate the UI acts on.
 *
 * 409 = already enrolled = the desired end state (covers override-retry passes
 * where a member already succeeded on the first pass), so it counts as enrolled
 * — NOT an error. Any other non-ok status contributes its error message and, if
 * the route flagged requiresOverride, raises the override prompt.
 */
export function aggregateEnrollOutcomes(outcomes: EnrollOutcome[]): {
    enrolledIds: number[];
    errors: string[];
    needsOverride: boolean;
} {
    const enrolledIds: number[] = [];
    const errors: string[] = [];
    let needsOverride = false;

    for (const o of outcomes) {
        if (o.ok || o.status === 409) {
            enrolledIds.push(o.participantId);
            continue;
        }
        if (o.requiresOverride) needsOverride = true;
        errors.push(o.error || "Failed to enroll in program.");
    }

    return { enrolledIds, errors, needsOverride };
}

/**
 * Build the Shopify cart permalink for an enrolled household.
 *
 * Membership is household-level → every selected member shares ONE variant
 * tier, so we charge qty=N of that single variant and pass all account ids
 * comma-joined. The orders/paid webhook splits CheckMeIn_Account_ID on ',' and
 * activates each (webhooks/shopify/route.ts). Constraint: holds only while one
 * household = one membership tier = one variant.
 *
 * `discountCode` (single-pool model only — see mintMemberDiscountCode in
 * lib/shopify.ts) is prepended as `discount=<code>`, mirroring
 * buildMembershipCheckoutUrl's existing discount-code convention.
 */
export function buildShopifyCheckoutUrl(
    storeDomain: string | undefined,
    variantId: string,
    enrolledIds: number[],
    programId: string | number,
    discountCode?: string | null,
): string {
    const accountIds = enrolledIds.join(',');
    const parts: string[] = [];
    if (discountCode) parts.push(`discount=${encodeURIComponent(discountCode)}`);
    parts.push(`attributes[CheckMeIn_Account_ID]=${accountIds}`);
    parts.push(`attributes[Program_ID]=${programId}`);
    return `https://${storeDomain}/cart/${variantId}:${enrolledIds.length}?${parts.join('&')}`;
}

export type RepeatPayment = { personId: number; name: string };

/**
 * The selected children already ACTIVE (paid) in this program. Matched per child
 * (personId), so a sibling already paid never flags a new sibling. PENDING is not
 * flagged: resuming an abandoned checkout is the normal path. The page warns on
 * these and lets the family continue: flag, don't prevent.
 */
export function findRepeatPayments(
    selectedIds: number[],
    rows: { personId: number; status?: string; person?: { name: string | null } }[],
    nameOf: (personId: number) => string | null | undefined,
): RepeatPayment[] {
    return selectedIds.flatMap((personId) => {
        const row = rows.find((r) => r.personId === personId && r.status === 'ACTIVE');
        if (!row) return [];
        return [{ personId, name: nameOf(personId) || row.person?.name || 'This participant' }];
    });
}
