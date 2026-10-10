import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * LIVE_PERSON drift guard (lib/person/filters.ts) — the Person analogue of
 * lifecycleStatusLiteralAllowlist.test.ts / EDGE_INCLUDE_ALLOWLIST. Mechanics
 * (walk/skip dirs, comment-and-string-safe brace capture) are lifted straight
 * from that test.
 *
 * A merged-away Person is a TOMBSTONE, not a deleted row: `mergedIntoId` gets
 * set and the row survives forever (audit trail, moved/left join rows). Any
 * code that reads Person without routing through LIVE_PERSON (lib/person/filters.ts)
 * can silently start showing/counting a tombstone the day a merge happens to
 * touch its data — there is no compiler error, just a ghost in a list. This test
 * greps every Person-query SITE in src/app + src/lib and asserts each one either
 * (a) references LIVE_PERSON / mergedIntoId in its own query context, or
 * (b) is named in the ALLOWLIST below with a reviewed justification.
 *
 * WHAT COUNTS AS A "SITE" (three independent patterns, matching how this codebase
 * actually reads Person — see lib/person/filters.ts's consumers):
 *
 *   1. A direct list/count/mass-write call on the Person delegate:
 *        prisma.person.findMany(...) / .findFirst(...) / .count(...) /
 *        .aggregate(...) / .groupBy(...) / .updateMany(...) / .deleteMany(...)
 *                                                  (via prisma, tx, or db)
 *      excluding `findUnique` / `findUniqueOrThrow` and the single-row writes
 *      `update` / `delete` / `upsert` — see the boundary note below.
 *
 *   2. A nested pull of Person data through another model's query, under ANY of
 *      the Person-typed relation names in prisma/schema.prisma — `person`, but
 *      equally `householdMembers`, `subjectPerson`, `reviewer`, `leadMentor`, `user`, …:
 *        `<rel>: true`                          (include shorthand), or
 *        `<rel>: { ... select: ... }`           (nested select), or
 *        `<rel>: { ... include: ... }`          (nested include)
 *      That name list is DERIVED from the schema at test time
 *      (PERSON_RELATION_NAMES below), never hand-written: a Person relation under
 *      an unobvious name is exactly the blind spot this pattern exists to close,
 *      and a hand-kept list reopens it the day someone adds one.
 *      A `<rel>: { <field>: <value> }` object that carries neither `select:`
 *      nor `include:` — e.g. `person: { isKeyholder: true }`, `person: { householdId }`
 *      — is a WHERE-relation FILTER, not a data pull: it narrows the parent rows,
 *      it doesn't expose a Person's identity. That shape is intentionally out of
 *      scope (see the boundary note below).
 *
 *   3. A list/count call on a JOIN delegate that has a `person` relation:
 *        prisma.programParticipant|programVolunteer|rSVP|toolStatus
 *          .findMany(...) / .findFirst(...) / .count(...) / .aggregate(...) / .groupBy(...)
 *      excluding `findUnique` / `findUniqueOrThrow`, same as class 1.
 *      WHY THIS EXISTS: pattern 2's "a where-relation filter is not a data pull"
 *      reasoning holds for IDENTITY leaks but not for COUNTS. A headcount over a
 *      join table carries no `person:` key at all —
 *        prisma.programParticipant.count({ where: { programId } })
 *      matches neither pattern above, yet a tombstone's left-behind enrollment row
 *      (merge/route.ts leaves colliding rows on the tombstone) inflates that number
 *      and can trip a capacity gate, without any Person data ever being read. So a
 *      join-table list/count is a site in its own right: it must filter through the
 *      `person` relation (`where: { person: LIVE_PERSON }`) or be allowlisted.
 *
 * BOUNDARY — why the unique-key shapes (`findUnique`/`findUniqueOrThrow`, and the
 * single-row writes `update`/`delete`/`upsert`) are excluded entirely (from
 * BOTH patterns: a `visit.findUnique({ include: { person: true } })` is just as
 * excluded as a bare `prisma.person.findUnique(...)`):
 *   thpr's model is LISTS AND COUNTS. A `findUnique` takes a unique key (id,
 *   email, a compound unique) and returns AT MOST ONE row picked by that key —
 *   it can never leak an extra tombstone into a roster or inflate a count, so
 *   filtering it is a no-op at best. `update`/`delete`/`upsert` take that same
 *   unique key on the write side: they touch the one row the caller already
 *   resolved, so they carry the same reasoning (only `updateMany`/`deleteMany`,
 *   whose where is an unrestricted filter, can sweep tombstones in unnoticed).
 *   This is also exactly the shape merge/analyze/
 *   scan (app/api/membership-ops/participants/merge{,/analyze}/route.ts,
 *   app/api/scan/route.ts) use to load the specific record they operate ON —
 *   which is why none of those three routes needs an ALLOWLIST entry: they
 *   never appear as a scanner hit in the first place. `findFirst` is NOT
 *   excluded by function name — even when it happens to carry an `id:` equality
 *   clause (functionally the same one-row shape) it still needs a human
 *   decision, which is what the ALLOWLIST's "id-scoped findFirst" entries below
 *   record.
 *
 * THE SWEEP-VS-DISPLAY RULE (thpr, verbatim) — the test for every ALLOWLIST entry:
 *
 *     "reconcilers and cleanup sweeps must still see tombstone rows; only
 *      human-facing lists and counts filter them."
 *
 * THE WRITE RULE (mass writes — `updateMany`/`deleteMany`) — the read rule does
 * NOT transfer, so allowlisting a write needs its own judgement. A read that sees
 * a tombstone is a ghost in a list; a write that hits one silently corrupts a row
 * nobody will ever look at again. The default therefore flips: a mass write
 * filters unless it is one of two things.
 *   - TOMBSTONE MACHINERY: the merge CAS itself, which targets the tombstone on
 *     purpose (it names `mergedIntoId`, so it passes this guard for free).
 *   - STRUCTURAL: a write that must touch every row pointing at something,
 *     liveness irrelevant — e.g. reparenting a household's members before
 *     deleting the household, where skipping the tombstones leaves the RESTRICT
 *     FK unsatisfiable and the whole operation fails.
 * Everything that mutates the LIVE population — stamping a background check,
 * flagging an address, flipping a flag someone reads back — filters.
 *
 * Two assertions: no unlisted unfiltered site, and no stale allowlist entry
 * (a listed file that no longer has an unfiltered site must be removed —
 * keeps the list honest, same as the lifecycle guard).
 */

const SRC = join(__dirname, '..');
const SCHEMA = join(SRC, '..', 'prisma', 'schema.prisma');

/**
 * Every relation field typed `Person` / `Person[]` in the schema — the class-2
 * keys. Read from the schema rather than listed here on purpose: `person` is the
 * obvious name, `householdMembers` / `subjectPerson` / `reviewer` / `user` are
 * not, and the next one nobody thinks of should be in scope the moment it exists.
 */
const PERSON_RELATION_NAMES = [
    ...new Set(
        [...readFileSync(SCHEMA, 'utf8').matchAll(/^[ \t]+(\w+)[ \t]+Person(?:\[\])?\??(?:[ \t]|$)/gm)].map((m) => m[1]),
    ),
];

/**
 * Every file with a Person-query site that intentionally does NOT route
 * through LIVE_PERSON, with a reviewed reason. Grouped by the sweep-vs-display
 * rule above, plus two narrower categories the rule implies:
 *   - "id-scoped findFirst": a findFirst carrying an explicit id-equality
 *     clause is the same one-row shape as findUnique-by-id (see the boundary
 *     note above) — just not excluded by function name, so it needs a listed
 *     reason instead of a silent pass.
 *   - "historical / audit trail": a record of who did something in the past
 *     (an audit-log actor, a facility visit, a financial reconciliation
 *     match) should still show a since-merged person's name — hiding it
 *     would falsify history, not protect anyone.
 */
const ALLOWLIST: Record<string, string> = {
    // ── sweeps / reconcilers (rule: "must still see tombstone rows") ──────────
    'lib/lifecycleDrift.ts': 'I1 auto-heal (releases stranded inventoryHeldAt). It never reads Person data — scanLifecycleViolations/runLifecycleReconcile read and update programParticipant fields (personId, status, inventoryHeldAt) directly — but its programParticipant.findMany calls are class-3 sites. Filtering them would be a REGRESSION, not a fix: a merge deliberately leaves colliding enrollment rows on the tombstone (merge/route.ts step 4), and those are exactly the rows whose holds need releasing. Hidden from this sweep they become immortal and leak held Shopify inventory forever. Same sweep rationale as the two cron entries below.',
    'app/api/cron/pending-participants/route.ts': '7-day clock → withdrawAndReleaseHold — must see a tombstoned participant to release its hold.',
    'app/api/cron/scholarship-grace-expiry/route.ts': 'Grace cutoff sweep — must see a tombstoned participant to release its held seat.',
    'lib/finance/reconcile.ts': 'Payment reconciler: a Shopify order must still settle a PENDING programParticipant "left" on a tombstone by a merge collision (merge/route.ts step 4) — that row has no other owner to settle it.',
    'app/api/finance-ops/s-read/match-audit/track/route.ts': 'Order-claim reconciliation check: `programParticipant.findFirst({ where: { shopifyOrderId } })` asks "has any enrollment already claimed this order". A merge-collision row left on a tombstone still holds the order — filtering it would falsely report the order unmatched and raise a spurious payment exception.',
    'lib/scan-service.ts': 'Facility force-checkout sweep (last keyholder leaving): must see every open visit, including a merge-orphaned tombstone\'s (merge/route.ts leaves a concurrently-open visit in place), or it never gets force-closed.',
    'app/api/cron/nightly/route.ts': 'Nightly force-checkout sweep: must see every open visit, including a merge-orphaned tombstone\'s, or a stranded open visit is never released (same rationale as lifecycleDrift.ts\'s I1 heal).',

    // ── structural mass writes (the write rule\'s second exception) ────────────
    'app/api/membership-ops/participants/import/route.ts': 'Household merge, structural write: `tx.person.updateMany({ where: { householdId: source } })` reparents EVERY row in the source household so the following `household.delete` can run. A tombstone skipped here keeps pointing at the source household, the RESTRICT FK rejects the delete, and the whole merge rolls back. The two lead-cap reads and the cap re-check in the same file DO filter LIVE_PERSON — only the reparent is unfiltered, and deliberately.',

    // ── id-scoped findFirst (one-row shape, same boundary as findUnique-by-id) ─
    'lib/orgMembership.ts': 'isActiveOrgMember ANDs an explicit `id: personId` into the where — at most one row, same shape as findUnique-by-id.',
    'app/api/nav/todo-counts/route.ts': 'isLead check ANDs `id: user.id` (the caller\'s own session id) into the where — at most one row, same shape as findUnique-by-id.',
    'app/api/programs/[id]/participants/route.ts': 'leadRecord check ANDs `id: currentUserId` (the caller\'s own session id) into the where — at most one row, same shape as findUnique-by-id.',
    'app/api/programs/[id]/request-payment-plan/route.ts': 'leadRecord check ANDs `id: currentUserId` (the caller\'s own session id) into the where — at most one row, same shape as findUnique-by-id. (This file also nests `person: true` off a programParticipant `findUnique` by compound key — same excluded shape as a bare findUnique-by-id.)',
    'lib/trusted-adult/service.ts': 'assertHouseholdLead ANDs an explicit `id: actorId` into the where — at most one row, same shape as findUnique-by-id.',
    'app/api/attendance/route.ts': 'Checkout POST loads the target visit via `visit.findUnique({ where: { id: visitId }, include: { person: true } })` — the outer query is a findUnique-by-id; nesting `person: true` off it is the same excluded one-row shape.',
    'lib/auth-options.ts': 'Dev persona mint ANDs an explicit `id: personaId` into the where (and is separately scoped to `@example.com`, mirroring dev-personas/route.ts) — at most one row, same shape as findUnique-by-id. The adapter\'s `account.findUnique({ include: { user: true } })` (Account.user is a Person relation) is the same excluded shape: one Person reached through a unique provider key.',

    // ── FK-pinned to-one Person relations (class 2, one row chosen by the FK) ──
    // A to-one relation pull resolves the single Person that record already points
    // at — it can neither leak an extra tombstone into a list nor inflate a count,
    // the same boundary as findUnique-by-id. Prisma also takes no `where` on a
    // to-one include, so the only available decision is whether the PARENT row
    // should exist at all, which belongs to the parent query.
    'app/api/membership/reviews/route.ts': 'The household-lead pull now filters LIVE_PERSON. `subjectPerson` is a to-one pinned by OrgMembershipProcess.subjectPersonId. NEEDS REVIEW: whether a PERSON_BG process whose subject has since been merged away should still sit in the reviewer queue is a lifecycle question about the PROCESS (cancel/retarget it), not a filter on this read — left as-is rather than guessed at.',
    'lib/membership/review.ts': 'The BG stamp writes by explicit id (`where: { id: { in: cleared } }`), and every id reaches it through `liveHouseholdLeadIds`, which filters LIVE_PERSON — a tombstone can never be named as a check subject. The remaining hits are to-one relations selected for eligibility math, not display: `subjectPerson` (the process\'s own subject, for the conflict-of-interest household compare) and `reviewer` on an existing attestation (the actor who already voted — a historical record that must still resolve, or the same-household guard silently stops applying to it).',

    // ── person-scoped join reads (class 3, one already-identified person) ─────
    // A join-table list whose where pins `personId` to a single already-known id
    // is not a roster and not a headcount: it answers "what is THIS person in",
    // so a tombstone can never be leaked into someone else's list or added to a
    // total. Same boundary as the id-scoped findFirst group above, one rung out.
    'lib/attendanceTransitions.ts': 'getRelevantProgramIds pins `personId: participantId` — the enrollment/volunteer rows of one already-identified person, used to pick their associated event on scan. Not a roster, not a count.',

    // ── authz target checks (class 3, never rendered or counted) ──────────────
    'app/api/events/[id]/route.ts': 'IDOR guard on an attendance correction\'s target: two findFirsts pinned to `personId: targetId` asking "is this one target enrolled or volunteering in this event\'s program". One-row shape, no list, no count, never rendered.',

    // ── historical / audit trail (showing a since-merged identity is correct) ──
    'app/api/membership-audit/bg-attestations/route.ts': 'BG attestation history: three FK-pinned to-one Person relations (reviewer, attestation.subjectPerson, process.subjectPerson) resolve names for historical attestation records. A reviewer or subject who has since been merged must still appear in the audit trail.',
    'app/api/system-status/audit-log/route.ts': 'Resolves actor names for audit-log rows by their recorded actorId — a historical record must still name an actor who has since been merged away.',
    'lib/finance/matchAudit.ts': 'Mixed file: the reconciliation match itself filters LIVE_PERSON (line ~280). Separately, resolving certifier/comper NAMES for the audit report needs any historical actor, including one since merged — a report-only id→name lookup, not a live roster.',
    'app/api/finance-ops/payments/route.ts': 'Resolves names/emails for a fixed set of person ids already attached to processed payment records — historical financial records must still name a payer who has since been merged. (The queue\'s household-lead contact pull is the opposite case — a live address to chase — and does filter LIVE_PERSON.)',
    'app/api/facility/trends/route.ts': 'Visit-history report: shows who was physically present at the time, including the rare merge-orphaned open visit (see lib/scan-service.ts) — historical accuracy, not a live roster.',
    'app/api/facility/visits/route.ts': 'Recent-visits log: same historical-accuracy rationale as facility/trends.',
    'app/api/facility/badges/route.ts': 'Raw badge-scan log: same historical-accuracy rationale as facility/trends.',
    'app/api/system-status/unsynced-scans/route.ts': 'Parked-scan review queue over the same RawBadgeLog rows as facility/badges, so the historical-accuracy rationale carries — but filtering here would be worse than a ghost: a parked row is WORK, and hiding it because its person was later merged would strand the scan unreviewed forever, which is the invariant-3 hole this surface exists to close. The name shown resolves through the live relation, so a merged person appears under the surviving identity — which is the one the reviewer will find in the manual-visit tool anyway.',
    'app/api/household/visits/route.ts': 'Household visit-history view: same historical-accuracy rationale as facility/trends.',
    'lib/attendanceConflicts.ts': 'Attendance-conflict report over past visits: same historical-accuracy rationale as facility/trends.',

    // ── safe by construction via another site's fix (scanner can't see across files) ──
    'app/api/programs/mine/route.ts': 'personId set is sourced from activityMembers() (lib/household/activityMembers.ts), which filters LIVE_PERSON — this join\'s person select can only resolve to a live person by construction; the scanner can\'t see that cross-file guarantee textually.',
    'app/api/events/mine/route.ts': 'Same construction as programs/mine: both join reads pin `personId: { in: householdMemberIds }`, and that id set comes from activityMembers() (lib/household/activityMembers.ts), which filters LIVE_PERSON.',
    'app/api/shop/certifications/route.ts': 'Scanner is textually blind to a VARIABLE-held where. The "All Assignments" grid — the only many-person list here — spells out `where: { person: LIVE_PERSON }` inline; the second findMany passes `whereClause`, whose two branches are `{ toolId, person: LIVE_PERSON }` (list) and `{ personId: targetUserId }` (one already-identified person). Both covered, neither visible in the captured argument object.',

    // ── dev-only tooling (no production / user-facing effect) ─────────────────
    'app/api/auth/dev-personas/route.ts': 'Dev-only persona picker (config.isDevInstance() gated), scoped to `email: { endsWith: "@example.com" }` — a merge tombstone\'s email is always rewritten to merged-*@deleted.invalid (merge/route.ts step 1 CAS), so it can never match this domain filter.',
    'app/api/dev/shopify/orders-paid/route.ts': 'Dev-only mock-webhook firer (config.isDevInstance() gated). Both join reads pin `personId: { in: participantIds }` from the request body and are echoed back to the dev UI — no production or user-facing effect.',
    'lib/dev/seed-helpers.ts': 'Dev seed helper: picks an arbitrary sample of existing persons for local macro/demo flows. No production or user-facing effect.',
};

// ── scanner (walk / captureObject copied from lifecycleStatusLiteralAllowlist.test.ts) ──

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

/** A copy of `src` with comment bodies blanked to spaces — same length, so every
 *  index computed below still lines up with the original. Without it a relation
 *  name quoted in a comment ("a plain `householdMembers: true` returns…") reads as
 *  a site, and a LIVE_PERSON mentioned in one reads as its filter. */
function maskComments(s: string): string {
    const out = s.split('');
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        const d = s[i + 1];
        if (c === '/' && d === '/') {
            while (i < s.length && s[i] !== '\n') out[i++] = ' ';
        } else if (c === '/' && d === '*') {
            const end = s.indexOf('*/', i + 2);
            const stop = end < 0 ? s.length : end + 2;
            while (i < stop) {
                if (s[i] !== '\n') out[i] = ' ';
                i++;
            }
        } else if (c === "'" || c === '"' || c === '`') {
            i++;
            while (i < s.length && s[i] !== c) {
                if (s[i] === '\\') i++;
                i++;
            }
        }
    }
    return out.join('');
}

/** Capture the object literal at/after `from`, skipping strings & comments so a
 *  brace inside them can't unbalance the scan. Returns the text and the index just
 *  past the closing brace. */
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

// Class 1: a direct list/count/mass-write call on the Person delegate. The
// unique-key shapes — findUnique(OrThrow), update, delete, upsert — are
// deliberately absent from this alternation; see the boundary note above.
const PERSON_CALL_RE =
    /\b(?:prisma|tx|db)\.person\.(findMany|findFirst|count|aggregate|groupBy|updateMany|deleteMany)\s*\(/g;

// Class 2: a nested pull of Person data through another model's query, under any
// Person-typed relation name — `<rel>: true` or `<rel>: {` (the latter only counts
// as a hit when its body carries `select:`/`include:`; a pure relation FILTER like
// `person: { isKeyholder: true }` is checked below and skipped).
const PERSON_RELATION_RE = new RegExp(String.raw`\b(?:${PERSON_RELATION_NAMES.join('|')})\s*:\s*(true|\{)`, 'g');

// Class 3: a list/count call on a join delegate carrying a `person` relation.
// Same findUnique(OrThrow) exclusion as class 1, and the captured argument object
// is checked with the same FILTERED_RE — see the class-3 note in the header for
// why a count with no `person:` key at all still needs the filter.
const JOIN_CALL_RE =
    /\b(?:prisma|tx|db)\.(programParticipant|programVolunteer|rSVP|toolStatus)\.(findMany|findFirst|count|aggregate|groupBy)\s*\(/g;

const FILTERED_RE = /LIVE_PERSON|mergedIntoId/;

/**
 * A sibling `where: { person: LIVE_PERSON }` for a class-2 hit lives in the
 * ENCLOSING relation-config object, not inside the match itself — e.g.
 * `participants: { where: { person: LIVE_PERSON }, include: { person: {...} } }`.
 * A fixed-size backward slice (the lifecycle guard's 240-char model-attribution
 * lookback) is too fragile here: it can either miss a sibling `where` that's
 * pushed just past the cutoff by intervening comments (false "unfiltered"), or —
 * worse — reach backward across the call's OWN boundary into an unrelated
 * `import { LIVE_PERSON }` line or a previous statement (false "filtered").
 * Instead, walk backward with a brace-depth count (same string/comment-blind
 * simplification as captureObject) to the start of the nearest ENCLOSING
 * `foo.bar({` call's own argument object — i.e. "how far can LIVE_PERSON be
 * and still plausibly belong to THIS query" — and search that whole span
 * forward, however deep the nesting.
 */
function enclosingCallArgsStart(s: string, pos: number): number {
    let i = pos;
    let depth = 0;
    while (i > 0) {
        i--;
        const c = s[i];
        if (c === '}') {
            depth++;
        } else if (c === '{') {
            if (depth === 0) {
                let j = i - 1;
                while (j >= 0 && /\s/.test(s[j])) j--;
                if (s[j] === '(') return i; // '{' right after '(' — this call's own args object
                // A nested object key (include:/select:/a relation config) — pop
                // this level and keep walking out to find the enclosing call.
            } else {
                depth--;
            }
        }
    }
    return 0;
}

function scan(): Set<string> {
    const hits = new Set<string>();
    for (const file of walk(SRC)) {
        const src = maskComments(readFileSync(file, 'utf8'));
        const rel = relative(SRC, file).split(sep).join('/');

        PERSON_CALL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = PERSON_CALL_RE.exec(src))) {
            const parenIndex = m.index + m[0].length - 1; // the call's own '('
            const args = captureObject(src, parenIndex);
            const scopeText = args ? args.text : src.slice(m.index, m.index + 200);
            if (!FILTERED_RE.test(scopeText)) hits.add(rel);
        }

        JOIN_CALL_RE.lastIndex = 0;
        while ((m = JOIN_CALL_RE.exec(src))) {
            const parenIndex = m.index + m[0].length - 1; // the call's own '('
            const args = captureObject(src, parenIndex);
            const scopeText = args ? args.text : src.slice(m.index, m.index + 200);
            if (!FILTERED_RE.test(scopeText)) hits.add(rel);
        }

        PERSON_RELATION_RE.lastIndex = 0;
        while ((m = PERSON_RELATION_RE.exec(src))) {
            let scopeEnd = m.index + m[0].length;
            if (m[1] === '{') {
                const obj = captureObject(src, m.index);
                if (!obj) continue;
                if (!/\b(?:select|include)\s*:/.test(obj.text)) continue; // pure filter, not a data pull
                scopeEnd = obj.end;
            }
            const windowStart = enclosingCallArgsStart(src, m.index);
            const scopeText = src.slice(windowStart, scopeEnd);
            if (!FILTERED_RE.test(scopeText)) hits.add(rel);
        }
    }
    return hits;
}

describe('LIVE_PERSON drift guard', () => {
    const flagged = [...scan()];
    const known = new Set(Object.keys(ALLOWLIST));

    it('no unfiltered Person-query site outside the ALLOWLIST', () => {
        const unexpected = flagged.filter((f) => !known.has(f)).sort();
        // A new one of these must either spread LIVE_PERSON into its where, or be
        // added to ALLOWLIST above with a reviewed justification (see the
        // sweep-vs-display rule in this file's header).
        expect(unexpected).toEqual([]);
    });

    // An empty/short name list would silently make class 2 scan for nothing, so
    // the schema parse is asserted rather than trusted.
    it('derives the Person relation names from the schema', () => {
        expect(PERSON_RELATION_NAMES).toEqual(expect.arrayContaining(['person', 'householdMembers', 'subjectPerson']));
    });

    it('has no stale allowlist entry (a listed file no longer has an unfiltered site)', () => {
        const live = new Set(flagged);
        const stale = [...known].filter((f) => !live.has(f)).sort();
        expect(stale).toEqual([]);
    });
});
