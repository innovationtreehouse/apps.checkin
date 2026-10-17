import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Status-literal allowlist drift guard — the lifecycle
 * analogue of EDGE_INCLUDE_ALLOWLIST / authzRegistry.test.ts.
 *
 * A hand-encoded state-SET in a `where` on the ProgramParticipant or
 * OrgMembershipProcess models can silently drift from the ONE definition in the
 * machine module. This test scans src for every such set and asserts it appears
 * ONLY in:
 *   - the definition modules (enrollmentState.ts, membership/lifecycle.ts,
 *     lib/lifecycle/*) — the single source of "what is legal"; or
 *   - the ALLOWLIST below: sites that keep such a `where` on purpose — CAS
 *     status+flag transition guards (from-state ∧ a lifecycle flag = a *transition*,
 *     not a plain state-set) and a handful of multi-status read/query filters not
 *     yet migrated onto a StateSet.where.
 *
 * SHARPENED GRANULARITY (why this test only flags SETS, not lone literals):
 *   The drift risk is a hand-listed *set of states* getting out of sync with the
 *   machine. A single bare `status: 'ACTIVE'` read carries none of that risk — it is
 *   pure indirection, trivially wrappable in a StateSet later with zero behavioural
 *   change. Flagging every lone literal forced ~8 single-status reads into the
 *   allowlist purely to absorb false-positives, burying the real signal. So a `where`
 *   is flagged ONLY when its status clause is a genuine multi-status construct:
 *     - a set filter: `status: { in: [...] }` or `status: { notIn: [...] }`, OR
 *     - a `status: '<literal>'` appearing ALONGSIDE ≥1 lifecycle flag condition in the
 *       same object (a status+flag CAS guard — from-state plus a flag it also sets).
 *   A lone `status: 'X'` with no set and no flag is NOT flagged.
 *
 * A new such construct anywhere else fails CI, forcing the author to either consume a
 * StateSet or register here with a justification — exactly how a new sensitive
 * `include` must earn an EDGE_INCLUDE_ALLOWLIST entry.
 *
 * The irreducibly-human call (is a new set a duplicate of a StateSet or a
 * legitimately-new transition guard?) is what the allowlist forces into review; a
 * person answers it. Everything above is machine-checked.
 *
 * Scope / precision (a deliberate, documented simplification):
 *   - Only `where:{…}` blocks are scanned — `data:`/`oldData:`/`newData:` writes and
 *     `p.status === '…'` comparisons are NOT state-set drift and are ignored.
 *   - A set spelled with a canonical constant (`status: { in: [...IN_FLIGHT_RENEWAL] }`)
 *     carries no bare literal, so it is INVISIBLE to this scanner by design — it already
 *     consumes the one definition and cannot drift.
 *   - Distinctive OrgMembershipProcessStatus literals (INTAKE, PENDING_BG_REVIEW, …)
 *     are attributed unambiguously. The two SHARED literals `ACTIVE`/`PENDING` also
 *     appear in OrgMembershipStatus/RSVPStatus/etc, so they are counted only when a
 *     `programParticipant` / `orgMembershipProcess` Prisma delegate sits just before
 *     the `where` (model attribution). A shared literal on some other model's `where`
 *     is correctly out of scope.
 */

const SRC = join(__dirname, '..');

const PP_LITERALS = ['PENDING', 'ACTIVE'] as const;
const OMP_LITERALS = [
    'INTAKE',
    'PENDING_EXTERNAL_ACTION',
    'PENDING_BG_REVIEW',
    'PENDING_PAYMENT',
    'PENDING_BG_CLEARANCE',
    'ACTIVE',
    'BLOCKED',
    'PENDING_RENEWAL',
    'RENEWAL_PENDING_BG',
    'ARCHIVED',
] as const;
const SHARED = new Set<string>(PP_LITERALS); // ACTIVE / PENDING — ambiguous across enums
const OMP_DISTINCT = OMP_LITERALS.filter((l) => !SHARED.has(l));
const ALL_LITERALS = [...new Set<string>([...PP_LITERALS, ...OMP_LITERALS])];

// Lifecycle flag columns whose presence next to a bare status literal marks a
// status+flag CAS guard (a *transition*, not a plain read). One list, checked as a
// union — a flag "belongs" to a model only loosely, and a status+flag combo is a
// transition regardless of which flag it pairs with.
const LIFECYCLE_FLAGS = [
    'inventoryHeldAt',
    'paymentPlanDeniedAt',
    'isPaymentPlanRequested', // ProgramParticipant
    'contractSignedAt',
    'bgConsentAt',
    'bgClearedAt',
    'paidAt', // OrgMembershipProcess
] as const;

// Always-allowed: the definition layer itself is where literals are supposed to live.
function isDefinitionModule(rel: string): boolean {
    const p = rel.split(sep).join('/');
    return (
        p.startsWith('lib/lifecycle/') ||
        p === 'lib/programs/enrollmentState.ts' ||
        p === 'lib/membership/lifecycle.ts'
    );
}

/**
 * Every non-definition source file that keeps a genuine multi-status `where` construct
 * (a set, or a status+flag CAS combo — see the sharpened match above) on one of the two
 * models, each with a justification. `T#` = the transition id from the state machine
 * docs. New entries need a real reason; a stale one (no such construct left) also fails,
 * keeping the list honest.
 *
 * Note: lone single-status reads (a bare `status: 'ACTIVE'` filter) are NO LONGER flagged
 * and therefore do NOT belong here — they are pure indirection with zero drift risk. This
 * is why files like facility/trends, renewal-status, notifications, payment.ts, and
 * orgMembership.ts (all single-status reads) are absent; likewise single-status CAS guards
 * (activateEnrollment PENDING→ACTIVE, archive ARCHIVED→target) and sets spelled with a
 * canonical constant (renewal's `{ in: [...IN_FLIGHT_RENEWAL] }` and the PERSON_BG
 * existence set's `...personBgOpen.where`, which carry no bare literal and cannot drift).
 */
const ALLOWLIST: Record<string, string> = {
    // ── CAS transition guards now source their from-state status from the definition (#1080) ──
    // The enrollment guards (activateEnrollment, request-payment-plan, payment-plans
    // approve/refuse/manual-hold) and the membership advanceExternal/beginRenewal/unarchive/
    // membership-payment-plans guards spread `...fromWhere(<from>)` instead of a raw `status:`
    // literal, so they carry NO bare status literal and no longer appear here — the guard↔table
    // parity test (guardFromStateParity.test.ts) is what keeps them honest now. (renewal's
    // beginRenewalForUser read is a LONE single-status literal, which the sharpened scanner no
    // longer flags either, so it isn't listed.)

    // Not a transition from-state: the PERSON_AGREEMENT edge is ∅→PENDING_EXTERNAL_ACTION
    // (no from-row). This is the "already handled this cycle" existence set — in flight, OR
    // terminal since the cycle floor — spanning an in-flight AND a terminal status, which no
    // single StateSet expresses. Owned by personAgreementTriggers.handledThisCycleWhere; this
    // board read is the same set, inline. (The trigger module itself carries no `where:` block
    // for it — the set lives in a helper's return object — so it never reaches this scanner.)
    'app/api/membership-audit/compliance/route.ts':
        'PERSON_AGREEMENT handled-this-cycle set, read to list over-25 non-leads with no agreement yet: status=PENDING_EXTERNAL_ACTION, or status in {ACTIVE,ARCHIVED} since the cycle floor.',

    // ── invariant-driven reconciler (Phase 4) ──
    'lib/lifecycleDrift.ts':
        'I1 heal query: where status=ACTIVE,inventoryHeldAt not null — the off-diagram violation set itself (has no StateSet; it is precisely what validate() rejects).',

    // ── multi-status read / query filters (not yet migrated onto a StateSet.where) ──
    'app/api/membership-ops/applications/route.ts':
        'Board application list: live view is a set — status notIn {ACTIVE,ARCHIVED}.',
    'lib/nav/todoCounts.ts':
        'Dashboard counts: status+flag probes — {PENDING,isPaymentPlanRequested,inventoryHeldAt,paymentPlanDeniedAt} and {PENDING_PAYMENT,isPaymentPlanRequested}.',
    'lib/finance/reconcile.ts':
        'Reconciler paid-order set: where status in {ACTIVE,PENDING_BG_CLEARANCE} on OrgMembershipProcess.',
    'lib/finance/matchAudit.ts':
        'Audit read queries: activation sweep (ACTIVE/PENDING_BG_CLEARANCE + ACTIVE participants) and the claim lookup excluding ARCHIVED/BLOCKED — report-only, mirrors the reconcile.ts entry.',
};

// ── scanner ──────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
            if (!['node_modules', 'generated', '__tests__'].includes(e.name)) walk(full, out);
        } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
            out.push(full);
        }
    }
    return out;
}

/** Capture the object literal at/after `from`, skipping strings & comments so a
 *  brace inside them can't unbalance the scan. Returns the text and the index just
 *  past the closing brace (so a caller can look for a ternary else-branch). */
function captureObject(s: string, from: number): { text: string; end: number } | null {
    let i = s.indexOf('{', from);
    if (i < 0) return null;
    const start = i;
    let depth = 0;
    for (; i < s.length; i++) {
        const c = s[i];
        const d = s[i + 1];
        if (c === '/' && d === '/') {
            i = s.indexOf('\n', i);
            if (i < 0) i = s.length;
            continue;
        }
        if (c === '/' && d === '*') {
            i = s.indexOf('*/', i + 2);
            i = i < 0 ? s.length : i + 1;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            const q = c;
            i++;
            while (i < s.length && s[i] !== q) {
                if (s[i] === '\\') i++;
                i++;
            }
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return { text: s.slice(start, i + 1), end: i + 1 };
        }
    }
    return null;
}

/** The full filter for a `where:` match, INCLUDING a ternary else-branch. For
 *  `where: c ? { A } : { B }` we must see both branches — otherwise a set in the
 *  else-branch (e.g. `{ status: { notIn: [...] } }`) is invisible and the true
 *  multi-status filter goes unflagged. A `where` object is never followed by `:`,
 *  so a `: {` immediately after the first object unambiguously marks the else-branch. */
function captureWhere(s: string, from: number): string | null {
    const first = captureObject(s, from);
    if (!first) return null;
    const m = /^\s*:\s*(?=\{)/.exec(s.slice(first.end));
    if (!m) return first.text;
    const second = captureObject(s, first.end + m[0].length);
    return second ? `${first.text}\n${second.text}` : first.text;
}

// `where: {`  or  `where: cond ? {`  (a ternary whose first branch is the filter)
const WHERE_RE = /where\s*:\s*(?:[A-Za-z_$][\w.$]*\s*\?\s*)?\{/g;
// A status value expression: a quoted literal, or a `{ in: [...] }` / `{ not: … }`
// filter object (no nested braces — statuses never carry one).
const STATUS_VAL_RE = /status\s*:\s*(\{[^{}]*\}|'[^']*'|"[^"]*")/g;

/** Files with a raw status where-literal on ProgramParticipant / OrgMembershipProcess. */
function scan(): Set<string> {
    const hits = new Set<string>();
    for (const file of walk(SRC)) {
        const src = readFileSync(file, 'utf8');
        const rel = relative(SRC, file);
        WHERE_RE.lastIndex = 0;
        let wm: RegExpExecArray | null;
        while ((wm = WHERE_RE.exec(src))) {
            const body = captureWhere(src, wm.index);
            if (!body) continue;
            const pre = src.slice(Math.max(0, wm.index - 240), wm.index);
            const isPP = /\bprogramParticipant\b/.test(pre);
            const isOMP = /\borgMembershipProcess\b/.test(pre);
            // A lifecycle flag condition anywhere in this same `where` object turns a
            // bare status literal into a status+flag CAS combo.
            const bodyHasFlag = LIFECYCLE_FLAGS.some((f) => new RegExp(`\\b${f}\\b`).test(body));
            STATUS_VAL_RE.lastIndex = 0;
            let vm: RegExpExecArray | null;
            while ((vm = STATUS_VAL_RE.exec(body))) {
                const expr = vm[1];
                // A genuine multi-status SET: { in: [...] } / { notIn: [...] }. A bare
                // literal, or a single { not: 'X' } exclusion, is not a set.
                const isSet = expr[0] === '{' && /\b(?:in|notIn)\s*:/.test(expr);
                for (const lit of ALL_LITERALS) {
                    if (!new RegExp(`['"]${lit}['"]`).test(expr)) continue;
                    const inScope =
                        (OMP_DISTINCT as readonly string[]).includes(lit) || // unambiguous OMP literal
                        (isPP && (PP_LITERALS as readonly string[]).includes(lit)) ||
                        (isOMP && (OMP_LITERALS as readonly string[]).includes(lit));
                    if (!inScope) continue;
                    // Sharpened: only a real state-SET, or a status literal sitting
                    // alongside a lifecycle flag (a status+flag CAS combo), carries
                    // drift risk. A lone bare status literal is pure indirection.
                    if (isSet || bodyHasFlag) hits.add(rel.split(sep).join('/'));
                }
            }
        }
    }
    return hits;
}

describe('lifecycle status-literal allowlist drift guard', () => {
    const flagged = [...scan()].filter((f) => !isDefinitionModule(f));
    const known = new Set(Object.keys(ALLOWLIST));

    it('no raw status where-literal outside the definition modules + allowlist', () => {
        const unexpected = flagged.filter((f) => !known.has(f)).sort();
        // A new one of these must consume a StateSet.where or be added to ALLOWLIST
        // with a justification.
        expect(unexpected).toEqual([]);
    });

    it('has no stale allowlist entry (a listed file no longer keeps a status where-literal)', () => {
        const live = new Set(flagged);
        const stale = [...known].filter((f) => !live.has(f)).sort();
        expect(stale).toEqual([]);
    });
});
