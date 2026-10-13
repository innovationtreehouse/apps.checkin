import prisma from "@/lib/prisma";
import { isPaid, isReversed, membershipVariantIdSet } from "@/lib/finance/reconcile";
import * as mirror from "@/lib/shopifyRead/client";
import { normalizeAuditData } from "@/lib/auditPayload";
import { LIVE_PERSON } from "@/lib/person/filters";
import { programVariantIds } from "@/lib/programs/variants";

/**
 * Bidirectional Shopify ↔ activation match audit — the completeness check the
 * daily reconciler deliberately is not.
 *
 * The reconciler (reconcile.ts) is a cursor-driven recovery loop: it acts on
 * orders it can attribute and silently passes over the rest, and its reversal
 * pass only inspects activations that already carry an order id. That leaves
 * four populations nobody ever lists:
 *   - paid membership/program orders claimed by nothing (money in, no access),
 *   - activations whose order id isn't in the mirror (recorded, unverifiable),
 *   - activations with NO payment basis at all (access, no money) — the
 *     ACTIVE_WITHOUT_PAYMENT case that has had an enum value and board-alert
 *     copy since the reconciler shipped, but which nothing ever computed,
 *   - the legitimately-manual class (manually-recorded memberships, approved
 *     scholarships) that an auditor must see separated, not buried.
 *
 * "Should reconcile" is decided by VARIANT ID, the same key the storefront
 * links are built from: BoardSettings holds the membership variants, Program
 * rows hold the program variants. An order with none of those variants on any
 * line (donation, t-shirt) is out of scope by design and never reported.
 *
 * Read-only: this REPORTS; it raises no PaymentExceptions and changes nothing.
 * On-demand only (board click) — it reads the whole mirror-relevant surface,
 * which is exactly the kind of query the scale-to-zero cadence exists to bound.
 */

export type OrderBucket =
    /** Claimed by a membership process or program enrollment. */
    | "MATCHED"
    /** Not claimed, but an open/acknowledged PaymentException already tracks it. */
    | "TRACKED_EXCEPTION"
    /** Money is in, variant says membership/program, nothing claims it. THE gap. */
    | "UNCLAIMED_PAID"
    /** Not (or no longer) paid — pending/authorized/refunded/cancelled and unclaimed. Informational. */
    | "UNCLAIMED_UNPAID";

export interface AuditOrderRow {
    bucket: OrderBucket;
    orderLegacyId: string | null;
    /** Shopify order name (#1042). */
    name: string | null;
    customerEmail: string | null;
    financialStatus: string | null;
    totalCents: number;
    /** Order-level coupon codes (mirror shop_order.discount_codes, #1048). [] when un-couponed
     *  or pre-#1048. Shown on UNCLAIMED_PAID rows only — a coupon can explain a sub-dues total the
     *  auditor is eyeballing. Absence is NOT "no coupon" (see MirrorOrder.discountCodes). */
    discountCodes: string[];
    /** Which membership/program the variant match points at, e.g. "membership", "program: Robotics". */
    expected: string[];
}

export type MembershipBucket =
    | "ORDER_MATCHED"
    | "MANUAL_PAYMENT"
    | "ORDER_NOT_IN_MIRROR"
    | "PRE_MIRROR"
    | "ORDER_REVERSED"
    | "NO_PROCESS"
    | "NO_PAYMENT_BASIS"
    // Not claimed, but an open/acknowledged PaymentException already tracks it
    // (the Track button on the panel raises one) — parity with the order side.
    | "TRACKED_EXCEPTION";

export type EnrollmentBucket =
    | "ORDER_MATCHED"
    | "SCHOLARSHIP_APPROVED"
    | "ADMIN_COMPED"
    | "ORDER_NOT_IN_MIRROR"
    | "PRE_MIRROR"
    | "ORDER_REVERSED"
    | "NO_PAYMENT_BASIS"
    | "TRACKED_EXCEPTION";

export interface AuditMembershipRow {
    bucket: MembershipBucket;
    /** Null only for NO_PROCESS rows, which have no process (they are keyed by membershipId). */
    processId: number | null;
    /** Set for NO_PROCESS rows (the OrgMembership id); null for process-derived rows. */
    membershipId: number | null;
    householdName: string | null;
    shopifyOrderId: string | null;
    /** Who recorded the payment, for the MANUAL_PAYMENT rows — the "what is in audit as manual" answer. */
    manualPaymentByName: string | null;
}

export interface AuditEnrollmentRow {
    bucket: EnrollmentBucket;
    programId: number;
    programName: string;
    personId: number;
    personName: string | null;
    shopifyOrderId: string | null;
    /** Who comped it, for ADMIN_COMPED rows (the AuditLog CREATE row's actor). Null otherwise. */
    compedByName: string | null;
}

export interface MatchAuditResult {
    configured: boolean;
    /**
     * Mirror line rows carrying a variant id vs total. When withVariant is 0 while
     * lines exist, the mirror predates the variant columns and the order-side audit
     * is vacuous — run an s-read BACKFILL sync first. The UI must show this instead
     * of an empty (falsely clean) report.
     */
    variantCoverage: { lines: number; withVariant: number };
    /**
     * How many membership/program variant ids the app is configured with. 0 means
     * the order side of the audit is vacuous for a DIFFERENT reason than backfill:
     * nothing tells us which orders should reconcile. The UI must distinguish this
     * from a genuinely clean report.
     */
    configuredVariants: number;
    orders: AuditOrderRow[];
    memberships: AuditMembershipRow[];
    enrollments: AuditEnrollmentRow[];
}

export async function runMatchAudit(): Promise<MatchAuditResult> {
    if (!mirror.isConfigured()) {
        return { configured: false, variantCoverage: { lines: 0, withVariant: 0 }, configuredVariants: 0, orders: [], memberships: [], enrollments: [] };
    }

    // ── the "should reconcile" variant set ────────────────────────────────────
    const [settings, programs, variantCoverage] = await Promise.all([
        prisma.boardSettings.findUnique({
            where: { id: 1 },
            select: { orgMembershipVariantId: true },
        }),
        prisma.program.findMany({
            select: { id: true, name: true, shopifyVariantId: true, claimantShopifyVariantId: true },
        }),
        mirror.lineVariantStats(),
    ]);

    // The same set the reconciler's item gate uses — shared, not copied, so the
    // two can't drift (#1074 was exactly that drift).
    const membershipVariants = membershipVariantIdSet(settings ?? null);
    const programByVariant = new Map<string, { id: number; name: string }>();
    for (const p of programs) {
        for (const v of programVariantIds(p)) programByVariant.set(v, { id: p.id, name: p.name });
    }
    const allVariants = [...membershipVariants, ...programByVariant.keys()];

    // ── Shopify → activation: every reconcilable order accounted for ──────────
    const orders = await mirror.ordersForVariants(allVariants);
    const orderIds = orders.map((o) => o.legacyId).filter((v): v is string => !!v);

    // Claims are per-KIND, not per-order: a single checkout can carry membership
    // AND program lines, and "the membership process claimed this order" says
    // nothing about the program half. An ARCHIVED process is not a claim — the
    // application was abandoned, so its money is exactly the unclaimed kind.
    // A BLOCKED process is not a claim either: activate()'s BLOCKED branch (see
    // membership/payment.ts) stores paidAt + shopifyOrderId on a still-BLOCKED
    // process — money in, NO access granted, refund owed — so counting it as a
    // claim would bucket the order MATCHED and hide the exact case this audit
    // hunts. Excluded, the open PAID_WHILE_BLOCKED exception (which carries
    // processId) buckets it TRACKED_EXCEPTION instead.
    const [claimedProcs, claimedEnrolls, trackedExceptions] = await Promise.all([
        prisma.orgMembershipProcess.findMany({
            where: { shopifyOrderId: { in: orderIds }, status: { notIn: ["ARCHIVED", "BLOCKED"] } },
            select: { shopifyOrderId: true },
        }),
        prisma.programParticipant.findMany({ where: { shopifyOrderId: { in: orderIds } }, select: { shopifyOrderId: true, programId: true } }),
        prisma.paymentException.findMany({
            where: { shopifyOrderId: { in: orderIds }, status: { not: "RESOLVED" } },
            select: { shopifyOrderId: true, processId: true, programId: true },
        }),
    ]);
    const membershipClaimed = new Set(claimedProcs.map((r) => r.shopifyOrderId));
    const programsClaimed = new Map<string, Set<number>>();
    for (const r of claimedEnrolls) {
        if (!r.shopifyOrderId) continue;
        const set = programsClaimed.get(r.shopifyOrderId) ?? new Set<number>();
        set.add(r.programId);
        programsClaimed.set(r.shopifyOrderId, set);
    }
    // Tracking is per-kind too: an exception carrying processId covers the
    // MEMBERSHIP half, programId covers THAT program, and an order-level
    // exception (neither set, e.g. UNMATCHED_ORDER) covers the whole order.
    // Without this, one tracked half hides the other half's untracked gap.
    const trackedOrderLevel = new Set<string>();
    const trackedMembership = new Set<string>();
    const trackedPrograms = new Map<string, Set<number>>();
    for (const r of trackedExceptions) {
        if (!r.shopifyOrderId) continue;
        if (r.processId == null && r.programId == null) trackedOrderLevel.add(r.shopifyOrderId);
        if (r.processId != null) trackedMembership.add(r.shopifyOrderId);
        if (r.programId != null) {
            const set = trackedPrograms.get(r.shopifyOrderId) ?? new Set<number>();
            set.add(r.programId);
            trackedPrograms.set(r.shopifyOrderId, set);
        }
    }

    const orderRows: AuditOrderRow[] = orders.map((o) => {
        // What each matched variant should have produced, and whether it did.
        // A kind is ACCOUNTED when claimed or covered by an unresolved exception;
        // UNACCOUNTED kinds are the real gap.
        const unclaimed: string[] = [];
        const unaccounted: string[] = [];
        const expected: string[] = [];
        const orderTracked = !!o.legacyId && trackedOrderLevel.has(o.legacyId);
        for (const v of new Set(o.matchedVariantIds ?? [])) {
            if (membershipVariants.has(v)) {
                if (!expected.includes("membership")) {
                    expected.push("membership");
                    if (!(o.legacyId && membershipClaimed.has(o.legacyId))) {
                        unclaimed.push("membership");
                        if (!orderTracked && !(o.legacyId && trackedMembership.has(o.legacyId))) unaccounted.push("membership");
                    }
                }
            } else {
                const program = programByVariant.get(v);
                const label = `program: ${program?.name ?? v}`;
                if (!expected.includes(label)) {
                    expected.push(label);
                    const claimedSet = o.legacyId ? programsClaimed.get(o.legacyId) : undefined;
                    if (!(program && claimedSet?.has(program.id))) {
                        unclaimed.push(label);
                        const trackedSet = o.legacyId ? trackedPrograms.get(o.legacyId) : undefined;
                        if (!orderTracked && !(program && trackedSet?.has(program.id))) unaccounted.push(label);
                    }
                }
            }
        }
        const bucket: OrderBucket =
            unclaimed.length === 0
                ? "MATCHED"
                : unaccounted.length === 0
                  ? "TRACKED_EXCEPTION"
                  : isPaid(o)
                    ? "UNCLAIMED_PAID"
                    : "UNCLAIMED_UNPAID";
        return {
            bucket,
            orderLegacyId: o.legacyId,
            name: o.name,
            customerEmail: o.customerEmail,
            financialStatus: o.financialStatus,
            totalCents: o.totalCents,
            discountCodes: o.discountCodes,
            // MATCHED rows list everything the order bought; gap rows list only
            // the UNACCOUNTED half (a tracked half is the exception queue's
            // problem, not this row's), so a half-claimed checkout names its gap.
            expected: unaccounted.length > 0 ? unaccounted : unclaimed.length > 0 ? unclaimed : expected,
        };
    });

    // ── activation → Shopify: every activation has a payment basis ────────────
    // INITIAL/RENEWAL only: PERSON_BG processes carry no payment by design, so
    // including them would flood NO_PAYMENT_BASIS with false positives.
    const [procs, enrolls, noProcessMemberships] = await Promise.all([
        prisma.orgMembershipProcess.findMany({
            where: { status: { in: ["ACTIVE", "PENDING_BG_CLEARANCE"] }, kind: { in: ["INITIAL", "RENEWAL"] } },
            select: {
                id: true,
                shopifyOrderId: true,
                manualPaymentById: true,
                orgMembership: { select: { household: { select: { name: true } } } },
            },
        }),
        // Payment-bearing programs only: a FREE program sets initialStatus ACTIVE in the
        // participants route, so sweeping every ACTIVE participant floods NO_PAYMENT_BASIS.
        // "Carries payment" == has a Shopify variant id — the same "should reconcile" key the
        // order side uses. An order-backed row stays swept even if its program later dropped its
        // variant, so recorded money is always auditable. (No season-bounding: an old ACTIVE
        // enrollment IS current.)
        prisma.programParticipant.findMany({
            where: {
                status: "ACTIVE",
                person: LIVE_PERSON,
                OR: [
                    { shopifyOrderId: { not: null } },
                    { program: { shopifyVariantId: { not: null } } },
                ],
            },
            select: {
                programId: true,
                personId: true,
                shopifyOrderId: true,
                wasOrgMemberAtApproval: true,
                program: { select: { name: true } },
                person: { select: { name: true } },
            },
        }),
        // Item 5: an ACTIVE household membership with no INITIAL/RENEWAL process in any
        // non-ARCHIVED status has no payment/approval track behind it at all — a real gap.
        // Raw "ACTIVE" literal on the orgMembership delegate is guard-clean (the lifecycle
        // literal guard only scans programParticipant/orgMembershipProcess) and matchAudit is
        // allowlisted regardless. No season-bounding by design.
        prisma.orgMembership.findMany({
            where: {
                status: "ACTIVE",
                processes: { none: { kind: { in: ["INITIAL", "RENEWAL"] }, status: { not: "ARCHIVED" } } },
            },
            select: { id: true, household: { select: { name: true } } },
        }),
    ]);

    // ── item 2: admin-comped enrollments — the AuditLog CREATE row settles it ─
    // Candidates are exactly the enrollments that would otherwise be NO_PAYMENT_BASIS:
    // no order, no scholarship stamp.
    const compCandidates = enrolls.filter((e) => !e.shopifyOrderId && e.wasOrgMemberAtApproval == null);
    const candPersonIds = [...new Set(compCandidates.map((e) => e.personId))];
    const candProgramIds = [...new Set(compCandidates.map((e) => e.programId))];
    // ONE query, not N. Over-fetches cross (person,program) pairs; harmless — we only read exact
    // `${personId}:${programId}` keys. Newest CREATE wins (re-enroll after a withdrawal DELETE).
    const createRows = candPersonIds.length
        ? await prisma.auditLog.findMany({
              where: {
                  tableName: "ProgramParticipant",
                  action: "CREATE",
                  affectedEntityId: { in: candPersonIds },
                  secondaryAffectedEntity: { in: candProgramIds },
              },
              select: { affectedEntityId: true, secondaryAffectedEntity: true, actorId: true, newData: true },
              orderBy: { id: "desc" },
          })
        : [];
    const createByKey = new Map<string, { actorId: number; status: string | null }>();
    for (const r of createRows) {
        const key = `${r.affectedEntityId}:${r.secondaryAffectedEntity}`;
        if (createByKey.has(key)) continue; // desc order → first is newest
        const status = (normalizeAuditData(r.newData) as { status?: string } | null)?.status ?? null;
        createByKey.set(key, { actorId: r.actorId, status });
    }
    // A payment-bearing (free programs already filtered) enrollment CREATED active = admin comp.
    // ponytail: a household-merge (membership-ops/participants/merge) moves an enrollment to
    // the surviving personId but the CREATE audit row still names the OLD personId, so a merged
    // comp misses this lookup and falls to NO_PAYMENT_BASIS instead of ADMIN_COMPED. Safe
    // direction (surfaces, never hides) and rare; re-key by merge history if it gets noisy.
    const compActorId = (e: { personId: number; programId: number }) => createByKey.get(`${e.personId}:${e.programId}`)?.actorId;
    const createdActive = (e: { personId: number; programId: number; shopifyOrderId: string | null; wasOrgMemberAtApproval: boolean | null }) =>
        !e.shopifyOrderId && e.wasOrgMemberAtApproval == null && createByKey.get(`${e.personId}:${e.programId}`)?.status === "ACTIVE";

    // manualPaymentById / comp actor ids have no Prisma relation — resolve every name in one batch.
    const manualPaymentActorIds = [...new Set(procs.map((p) => p.manualPaymentById).filter((v): v is number => v != null))];
    const comperActorIds = compCandidates
        .map((e) => (createByKey.get(`${e.personId}:${e.programId}`)?.status === "ACTIVE" ? compActorId(e) : null))
        .filter((v): v is number => v != null);
    const nameIds = [...new Set([...manualPaymentActorIds, ...comperActorIds])];
    const people = nameIds.length
        ? await prisma.person.findMany({ where: { id: { in: nameIds } }, select: { id: true, name: true } })
        : [];
    const personName = new Map(people.map((p) => [p.id, p.name]));

    // ── items 3 & 4: reversal state + the mirror's low-water mark ─────────────
    // Out of scope (P3, not this pass): no re-validation that a mirrored order's
    // lines actually contain the recorded process/enrollment's variant — presence
    // in the mirror is enough for ORDER_MATCHED here.
    const activationOrderIds = [
        ...procs.map((p) => p.shopifyOrderId),
        ...enrolls.map((e) => e.shopifyOrderId),
    ].filter((v): v is string => !!v);
    const uniqueActivationIds = [...new Set(activationOrderIds)];

    // Tracked-exception lookups for the two P3-trackable gap buckets
    // (NO_PAYMENT_BASIS / ORDER_NOT_IN_MIRROR): batched IN-lists over the swept
    // ids, run in the same round-trip as the mirror presence lookup below.
    const procIds = procs.map((p) => p.id);
    const enrollProgramIds = [...new Set(enrolls.map((e) => e.programId))];
    const enrollPersonIds = [...new Set(enrolls.map((e) => e.personId))];
    const [inMirror, mirrorOrders, minReal, trackedProcRows, trackedEnrollRows] = await Promise.all([
        mirror.orderLegacyIdsPresent(uniqueActivationIds), // test=false authoritative present set
        mirror.ordersByLegacyIds(uniqueActivationIds),      // full rows, for reversal state only
        mirror.minRealOrderLegacyId(),
        procIds.length
            ? prisma.paymentException.findMany({
                  where: { status: { not: "RESOLVED" }, processId: { in: procIds } },
                  select: { processId: true },
              })
            : Promise.resolve([]),
        // Composite key: Prisma can't tuple-IN, so IN×IN over-fetches, then filter to
        // exact (programId, personId) pairs via a Set — same over-approximate-then-filter
        // shape the order side's trackedExceptions lookup uses, above.
        enrollProgramIds.length && enrollPersonIds.length
            ? prisma.paymentException.findMany({
                  where: { status: { not: "RESOLVED" }, programId: { in: enrollProgramIds }, personId: { in: enrollPersonIds } },
                  select: { programId: true, personId: true },
              })
            : Promise.resolve([]),
    ]);
    // No `kind` filter — parity with the order-side tracked lookup, which keys purely
    // on order + `status != RESOLVED`. Any open exception carrying this processId (or
    // this programId:personId) means the board is already tracking this activation.
    // It only ever overrides a row that is otherwise a gap (below), so a stray
    // order-linked exception on an ORDER_MATCHED row can't hide it.
    const trackedProcs = new Set(trackedProcRows.map((r) => r.processId));
    const trackedEnrolls = new Set(trackedEnrollRows.map((r) => `${r.programId}:${r.personId}`));
    // Reversal is only meaningful for orders that ARE present (test=false gated by inMirror below),
    // so a test order that ordersByLegacyIds returns can never become a payment basis here.
    const reversedIds = new Set(mirrorOrders.filter((o) => o.legacyId && isReversed(o)).map((o) => o.legacyId!));
    // Recorded id below the mirror's low-water mark = pre-mirror history, informational not a gap.
    const isPreMirror = (id: string) => minReal != null && /^\d+$/.test(id) && BigInt(id) < minReal;

    const membershipRows: AuditMembershipRow[] = procs.map((p) => {
        const raw: MembershipBucket = p.shopifyOrderId
            ? !inMirror.has(p.shopifyOrderId)
                ? (isPreMirror(p.shopifyOrderId) ? "PRE_MIRROR" : "ORDER_NOT_IN_MIRROR")
                : reversedIds.has(p.shopifyOrderId)
                    ? "ORDER_REVERSED"
                    : "ORDER_MATCHED"
            : p.manualPaymentById != null
                ? "MANUAL_PAYMENT"
                : "NO_PAYMENT_BASIS";
        // Override only the two trackable gaps — literal bucket names, so a P2
        // bucket this PR doesn't know about is never touched (see file header).
        const bucket: MembershipBucket =
            (raw === "NO_PAYMENT_BASIS" || raw === "ORDER_NOT_IN_MIRROR") && trackedProcs.has(p.id)
                ? "TRACKED_EXCEPTION"
                : raw;
        return {
            bucket,
            processId: p.id,
            membershipId: null,
            householdName: p.orgMembership?.household?.name ?? null,
            shopifyOrderId: p.shopifyOrderId,
            manualPaymentByName: p.manualPaymentById != null ? (personName.get(p.manualPaymentById) ?? `person ${p.manualPaymentById}`) : null,
        };
    });

    const noProcessRows: AuditMembershipRow[] = noProcessMemberships.map((m) => ({
        bucket: "NO_PROCESS",
        processId: null,
        membershipId: m.id,
        householdName: m.household?.name ?? null,
        shopifyOrderId: null,
        manualPaymentByName: null,
    }));

    const enrollmentRows: AuditEnrollmentRow[] = enrolls.map((e) => {
        const raw: EnrollmentBucket = e.shopifyOrderId
            ? !inMirror.has(e.shopifyOrderId)
                ? (isPreMirror(e.shopifyOrderId) ? "PRE_MIRROR" : "ORDER_NOT_IN_MIRROR")
                : reversedIds.has(e.shopifyOrderId)
                    ? "ORDER_REVERSED"
                    : "ORDER_MATCHED"
            : e.wasOrgMemberAtApproval != null
                ? "SCHOLARSHIP_APPROVED"
                : createdActive(e)
                    ? "ADMIN_COMPED"
                    : "NO_PAYMENT_BASIS";
        const bucket: EnrollmentBucket =
            (raw === "NO_PAYMENT_BASIS" || raw === "ORDER_NOT_IN_MIRROR") && trackedEnrolls.has(`${e.programId}:${e.personId}`)
                ? "TRACKED_EXCEPTION"
                : raw;
        return {
            bucket,
            programId: e.programId,
            programName: e.program.name,
            personId: e.personId,
            personName: e.person.name,
            shopifyOrderId: e.shopifyOrderId,
            compedByName: createdActive(e) ? (personName.get(compActorId(e)!) ?? null) : null,
        };
    });

    return {
        configured: true,
        variantCoverage,
        configuredVariants: allVariants.length,
        orders: orderRows,
        memberships: [...membershipRows, ...noProcessRows],
        enrollments: enrollmentRows,
    };
}
