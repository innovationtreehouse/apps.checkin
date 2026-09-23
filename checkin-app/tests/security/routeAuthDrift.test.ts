/**
 * Route auth drift-guard (Step 7 of docs/security/auth-consistency-analysis.md).
 *
 * Static text scan over EVERY `src/app/api/**​/route.ts`. It does NOT touch a DB
 * or run any route — it reads files from disk and asserts how each route ENTERS
 * the auth layer. This is the COMPLEMENT to the validator gate
 * (policy.contract.integration.test.ts + scopeValidators.test.ts): that gate
 * enforces field-stripping + grant-resolvability over REGISTERED routes; this
 * guard enforces that a route can only enter through a sanctioned front door in
 * the first place, so the "new route reaches for getServerSession / forgot to
 * wrap" class can't re-grow (it already re-grew 2→6 once; #580 cut it back).
 *
 * Three rules, each with an explicit, comment-justified allowlist as the ONLY
 * escape hatch:
 *   1. No raw `getServerSession` / `authOptions` in a route file. Use
 *      withAuth/handler (mandatory session), getOptionalSessionUser /
 *      authenticateRequest (optional/public session, lib/auth.ts), or
 *      withCron/withWebhook/withKiosk (non-session).
 *   2. A route that touches `prisma` must enter through one of those wrappers
 *      (or a public-read via getOptionalSessionUser/authenticateRequest). A bare
 *      `export async function GET/POST(...)` that hits prisma with no wrapper =
 *      drift.
 *   3. A GET/HEAD handler that READS an edge-sensitive model (ProgramParticipant,
 *      ProgramVolunteer, RSVP, Visit) must be on EDGE_INCLUDE_ALLOWLIST with a
 *      note on how it gates the edge. These models are all-public-tier, so the
 *      SENSITIVE thing is the existence of the row (who's enrolled / RSVP'd /
 *      present), not any field — per-field stripping can't protect them, and
 *      `_count` leaks the roster size even if tiered (the pre-#575 programs/[id]
 *      leak). Writes are out of scope here (GAP-2), so only GET/HEAD handlers
 *      are scanned. Edge reads via lib helpers (e.g. attendance → scan-service)
 *      are invisible to a route-file scan and rely on the validator gate's
 *      `returns:`/stripping instead.
 */
import * as fs from 'fs';
import * as path from 'path';
import { relations } from '@/security/core';

const API_DIR = path.resolve(__dirname, '../../src/app/api');

/**
 * The ONLY sanctioned exceptions. Adding to this Set is a visible, reviewed act
 * — every entry must point at an in-file justification. Paths are relative to
 * src/app/api.
 */
const ALLOWLIST = new Set<string>([
    // Raw getServerSession + authOptions. The dev persona-switch is not a normal
    // authenticated read: on local it must serve anonymous callers (the
    // logged-out picker IS the initial login path) and on cloud-dev it gates on
    // ANY session including a denied one. withAuth (mandatory session) can't
    // express that. Justified in-file at the GET handler ("DRIFT-GUARD ALLOWLIST").
    'auth/dev-personas/route.ts',
    // The NextAuth wiring route itself — it constructs NextAuth(authOptions) and
    // re-exports authOptions for back-compat. This is where authOptions LIVES at
    // the route layer; it imports no prisma and runs no handler of our own.
    'auth/[...nextauth]/route.ts',
    // Deliberately-anonymous PUBLIC WRITE (program self-registration form). It
    // cannot use withAuth (would 401 the public) and is not a read, so
    // getOptionalSessionUser doesn't apply. Abuse is bounded by IP + email rate
    // limits inside the handler (see the "email-bomb / DB-spam target" comment).
    'programs/[id]/public-register/route.ts',
    // Session-less, self-verifying via a signed HMAC token in the URL (?p=&sig=),
    // NOT a shared-secret family like withCron/withWebhook/withKiosk (no header,
    // no config-held secret to check) — see lib/outreach/unsubscribeToken.ts. GET
    // must not flip the flag (mail scanners prefetch GET links) and POST verifies
    // the token itself, so neither handler fits withAuth/withCron/withWebhook/
    // withKiosk, and it's genuinely public so getOptionalSessionUser doesn't apply
    // either. Bad/missing/tampered tokens get a neutral page, no info leak.
    'unsubscribe/route.ts',
]);

const HTTP_METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';
const WRAPPERS = 'withAuth|handler|withCron|withWebhook|withKiosk';
const PUBLIC_SESSION_HELPERS = /\b(getOptionalSessionUser|authenticateRequest)\s*\(/;

/** Strip block + line comments so commented-out mentions (e.g. "a raw
 * getServerSession would...") don't trip the scan. Preserves `://` in URLs. */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Rule 1: returns the offending token, or null. Detects real imports/usage of
 * getServerSession or authOptions (comments already stripped). */
function findRawSessionUse(code: string): string | null {
    if (/\bgetServerSession\b/.test(code)) return 'getServerSession';
    if (/\bauthOptions\b/.test(code)) return 'authOptions';
    return null;
}

/** True if the file imports a prisma client (the @/lib/prisma singleton or a
 * generated client). */
function usesPrisma(code: string): boolean {
    return /from\s+['"]@\/lib\/prisma['"]/.test(code) || /@\/generated\/prisma/.test(code);
}

/** Rule 2: returns a list of unwrapped exported handlers in a prisma route, or
 * []. File-level heuristic: if the file uses getOptionalSessionUser /
 * authenticateRequest anywhere, its bare handlers count as sanctioned
 * public-reads (good enough — a file mixing a public read with an unguarded
 * write is rare and would still trip the validator gate). */
function findUnwrappedPrismaHandlers(code: string): string[] {
    if (!usesPrisma(code)) return [];
    const publicReadOk = PUBLIC_SESSION_HELPERS.test(code);
    const violations: string[] = [];

    // `export const GET = withAuth<...>(...)` — RHS must be a sanctioned wrapper
    // call (optional generic args allowed).
    const constRe = new RegExp(
        `export\\s+const\\s+(${HTTP_METHODS})\\s*=\\s*([A-Za-z_]\\w*)`,
        'g',
    );
    for (const m of code.matchAll(constRe)) {
        if (!new RegExp(`^(${WRAPPERS})$`).test(m[2])) {
            violations.push(`export const ${m[1]} = ${m[2]}(...) — not a sanctioned wrapper`);
        }
    }

    // `export async function GET(...)` — a bare handler is only OK if the file is
    // a sanctioned public-read.
    const fnRe = new RegExp(`export\\s+async\\s+function\\s+(${HTTP_METHODS})\\b`, 'g');
    for (const m of code.matchAll(fnRe)) {
        if (!publicReadOk) {
            violations.push(`export async function ${m[1]}(...) — bare handler, no wrapper`);
        }
    }
    return violations;
}

// ---------------------------------------------------------------------------
// Rule 3 — edge-sensitive model reads (see §11 / §5.1a of the analysis doc).
// ---------------------------------------------------------------------------

/** Models whose rows are sensitive by EXISTENCE — all their fields are public
 * tier, so stripping can't protect them and a returned row (or _count) leaks
 * "who's enrolled / RSVP'd / present". */
const EDGE_MODELS = new Set(['ProgramParticipant', 'ProgramVolunteer', 'RSVP', 'Visit']);

/** The generated relations map, typed: ParentModel → relationKey → target. This
 * is what makes the scan parent-AWARE: a relation key resolves by enclosing
 * model — `participants` is ProgramParticipant under Program (edge), while the
 * household member set (`householdMembers`) is Person under Household (not),
 * so we must know the enclosing model — a flat key match can't, and would either
 * miss the Program case (the #575 leak class) or false-flag the Household case. */
const REL = relations as Record<string, Record<string, { model: string }>>;

/** Prisma client property → model name (Prisma lower-cases the first char, e.g.
 * `RSVP` → `rSVP`, `Program` → `program`). */
const PROP_TO_MODEL = new Map(Object.keys(REL).map((m) => [m[0].toLowerCase() + m.slice(1), m]));

const READ_OPS = 'findMany|findUnique|findFirst|findUniqueOrThrow|findFirstOrThrow|count|aggregate|groupBy';
const ROOT_RE = new RegExp(`prisma\\.(\\w+)\\.(?:${READ_OPS})\\s*(?:<[^>]*>)?\\s*\\(`, 'g');
const HANDLER_RE = new RegExp(
    `export\\s+(?:const|async\\s+function)\\s+(${HTTP_METHODS})\\b`,
    'g',
);

/** The exported HTTP method whose body contains index `idx` (nearest preceding
 * `export const/function METHOD`), or null. */
function enclosingMethod(code: string, idx: number): string | null {
    let cur: string | null = null;
    HANDLER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HANDLER_RE.exec(code))) {
        if (m.index < idx) cur = m[1];
        else break;
    }
    return cur;
}

// --- tiny object-literal walker (comments already stripped) -----------------
/** Index just past a string starting at a quote char (handles escapes; treats a
 * template literal as opaque — `${}` interpolation in a prisma query arg is not
 * a real case). */
function skipString(code: string, i: number): number {
    const q = code[i];
    i++;
    while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === q) return i + 1;
        i++;
    }
    return i;
}

/** Index of the `}` matching the `{` at `open`, skipping strings. */
function matchBrace(code: string, open: number): number {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        const c = code[i];
        if (c === '"' || c === "'" || c === '`') { i = skipString(code, i) - 1; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return i;
    }
    return code.length;
}

/** Index of the end of a value (top-level `,` or the enclosing close), skipping
 * nested brackets and strings. */
function skipValue(code: string, i: number, limit: number): number {
    let depth = 0;
    while (i < limit) {
        const c = code[i];
        if (c === '"' || c === "'" || c === '`') { i = skipString(code, i); continue; }
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') { if (depth === 0) return i; depth--; }
        else if (c === ',' && depth === 0) return i;
        i++;
    }
    return limit;
}

/** Top-level `key: value` entries of the object literal whose `{` is at `open`.
 * `braceStart` is the index of the value's `{` if the value is an object, else
 * null. Spreads / computed keys are skipped. */
function objectEntries(code: string, open: number): Array<{ key: string; braceStart: number | null }> {
    const close = matchBrace(code, open);
    const entries: Array<{ key: string; braceStart: number | null }> = [];
    let i = open + 1;
    while (i < close) {
        while (i < close && /[\s,]/.test(code[i])) i++;
        if (i >= close) break;
        const km = /^['"]?([A-Za-z_$][\w$]*)['"]?\s*:/.exec(code.slice(i, close));
        if (!km) { i = skipValue(code, i, close); continue; }
        let j = i + km[0].length;
        while (j < close && /\s/.test(code[j])) j++;
        entries.push({ key: km[1], braceStart: code[j] === '{' ? j : null });
        i = skipValue(code, j, close);
    }
    return entries;
}

/** Walk a prisma query args object (keys where/include/select/_count/…): only
 * include/select sub-objects expose returned relations. */
function walkArgs(code: string, open: number, model: string, found: Set<string>): void {
    for (const e of objectEntries(code, open)) {
        if ((e.key === 'include' || e.key === 'select') && e.braceStart != null) {
            walkRelations(code, e.braceStart, model, found);
        }
    }
}

/** Walk an include/select object whose keys are relations of `model`. Resolve
 * each key → target model via the map; flag edge targets; recurse into nested
 * include/select with the target model. `_count: { select: { rel: true } }`
 * resolves its inner keys under the same `model` (and leaks roster size). */
function walkRelations(code: string, open: number, model: string, found: Set<string>): void {
    for (const e of objectEntries(code, open)) {
        if (e.key === '_count') {
            if (e.braceStart != null) walkArgs(code, e.braceStart, model, found);
            continue;
        }
        const target = REL[model]?.[e.key]?.model;
        if (!target) continue;
        if (EDGE_MODELS.has(target)) found.add(target);
        if (e.braceStart != null) walkArgs(code, e.braceStart, target, found);
    }
}

/** Rule 3: edge MODELS read inside a GET/HEAD handler (response-leak surface).
 * Writes (POST/PATCH/…) are GAP-2, not this rule, so only GET/HEAD roots count.
 * Catches both a direct `prisma.<edgeModel>.<readOp>` and an include/select that
 * resolves (parent-aware) to an edge model at any nesting depth. Returns the set
 * of edge model names surfaced, or []. Limitation: a query whose args object is
 * built in a separate variable (not inline) is not walked — direct edge-model
 * roots are still caught; deeper relation includes built off-site rely on the
 * validator gate's `returns:`/stripping. */
function findEdgeReadsInReads(code: string): string[] {
    const found = new Set<string>();
    ROOT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROOT_RE.exec(code))) {
        const method = enclosingMethod(code, m.index);
        if (method !== 'GET' && method !== 'HEAD') continue;
        const model = PROP_TO_MODEL.get(m[1]);
        if (!model) continue;
        if (EDGE_MODELS.has(model)) found.add(model); // direct read of the edge model
        const parenIdx = m.index + m[0].length - 1;
        let k = parenIdx + 1;
        while (k < code.length && /\s/.test(code[k])) k++;
        if (code[k] === '{') walkArgs(code, k, model, found); // inline args object
    }
    return [...found];
}

function walkRouteFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkRouteFiles(full));
        else if (entry.name === 'route.ts') out.push(full);
    }
    return out;
}

const routeFiles = walkRouteFiles(API_DIR).map((f) => ({
    rel: path.relative(API_DIR, f),
    code: stripComments(fs.readFileSync(f, 'utf8')),
}));

const FIX_1 =
    'Use withAuth/handler (mandatory session), getOptionalSessionUser/authenticateRequest ' +
    '(optional/public session, lib/auth.ts), or withCron/withWebhook/withKiosk (non-session). ' +
    'If genuinely unavoidable, add the file to the ALLOWLIST in this test with a justification.';

// Routes whose GET/HEAD handler returns edge-sensitive rows. Each MUST gate the
// edge; the note says how — admission-gated (authorize/role rejects unauthorized
// callers), query-shaped (only returns the edge for authorized callers, like
// programs/[id] post-#575), admin-role-gated, or cron/webhook-gated (non-session
// service auth). Keys are the route dir (no /route.ts). Adding a row here is a
// reviewed assertion that the edge is protected.
const EDGE_INCLUDE_ALLOWLIST: Record<string, string> = {
    'cron/nightly': 'cron-gated — withCron, no user-facing response',
    'cron/pending-participants': 'cron-gated — withCron, no user-facing response',
    'cron/scholarship-grace-expiry': 'cron-gated — withCron, no user-facing response',
    'events/[id]': 'admission-gated — handler GET throws forbidden() unless staff (sysadmin/board/leadMentor/coreVol)',
    'events/mine': 'query-shaped — self + own household only (activityMembers → where participantId in memberIds)',
    'facility/trends': 'admin-role-gated — sysadmin/board',
    'facility/visits': 'admin-role-gated — sysadmin/board',
    'finance-ops/payment-plans': 'admin-role-gated — registry authorize anyRole [sysadmin, board]',
    'household/visits': "query-shaped — own household only (where householdId = caller's)",
    'membership-audit/compliance': 'admin-role-gated — withAuth roles [sysadmin, board]; reads ProgramParticipant/Volunteer to flag people needing a background check',
    'membership-audit/turning-18': 'admin-role-gated — registry authorize anyRole [sysadmin, board]; reads ProgramParticipant to mark which 18-year-olds are enrolled in a program',
    'membership-ops/households': 'admin-role-gated — withAuth roles [sysadmin, board]; ?id= branch includes each member ProgramParticipant for the household detail view',
    'membership-ops/participants/merge/analyze': 'admin-role-gated — sysadmin/board',
    'nav/todo-counts': 'query-shaped — counts scoped to caller (own household + programs the caller leads)',
    'profile': "query-shaped — authorize 'self'; visits are the caller's own",
    'profile/visits': 'query-shaped — self only (where participantId = caller)',
    'programs/[id]': 'query-shaped — participants/volunteers included only for staff/enrolled (#575)',
    'programs/mine': 'query-shaped — self + household only (where participantId in memberIds)',
    'programs': 'query-shaped — public catalog exposes _count of participants/volunteers (roster SIZE only, no identities/rows); member-only + draft visibility is gated',
    'safety/emergency-contacts': 'admin-role-gated — sysadmin/board/keyholder',
    'trusted-adults/operational': "admission-gated + query-shaped — authorize 'authenticated'; leads scoped to own-program households (where householdId in [...])",
};

const FIX_3 =
    'These models are all-public-tier, so the existence of the row is sensitive even ' +
    'though the fields are public (see §11 / §5.1a) — per-field stripping cannot protect it. ' +
    'Confirm the GET/HEAD handler admission-gates, query-shapes, or admin-role-gates this edge, ' +
    'then add it to EDGE_INCLUDE_ALLOWLIST with the justification.';

// ---------------------------------------------------------------------------
// Rule 4 — ops-stg access gate (2026-07-20 finding). getOptionalSessionUser
// collapses a gate-rejected caller (denied household, or on staging a non-org/
// non-canAccessStaging caller) to `undefined` — the SAME shape as a genuinely
// anonymous visitor, which is exactly the intended "public read" happy path in
// prod/dev. On ops-stg that collapse is wrong for a route whose data is real
// prod-copied content: "undefined" must ALSO mean "deny", not "serve the
// public view" (see programs/route.ts, attendance/route.ts). Scoped to actual
// CALLS of getOptionalSessionUser specifically — not authenticateRequest,
// which programs/[id]/route.ts also calls but only to ADD viewer-only fields
// on top of an already-registry-gated response (resolveAccess gates it
// independently; this rule would false-positive on that file).
// ---------------------------------------------------------------------------
const GET_OPTIONAL_SESSION_CALL = /\bgetOptionalSessionUser\s*\(/;
const IS_STAGING_CALL = /\bisStaging\s*\(\s*\)/;

function callsGetOptionalSessionUser(code: string): boolean {
    return GET_OPTIONAL_SESSION_CALL.test(code);
}

function hasStagingGateCheck(code: string): boolean {
    return IS_STAGING_CALL.test(code);
}

const FIX_4 =
    'On ops-stg, getOptionalSessionUser collapses a gate-rejected caller to the SAME ' +
    '`undefined` shape as a genuinely anonymous visitor. Add ' +
    '`if (config.isStaging() && !user) return apiError("Unauthorized", 401);` right after the ' +
    'getOptionalSessionUser call, or add this file to ALLOWLIST with a note on why it is safe ' +
    'to stay public even on staging (e.g. unsubscribe — no sensitive data, must stay reachable ' +
    'for mail scanners).';

describe('route auth drift-guard — every app/api/**/route.ts', () => {
    it('has route files to scan (guard is not vacuous)', () => {
        expect(routeFiles.length).toBeGreaterThan(50);
    });

    describe('rule 1 — no raw getServerSession/authOptions outside the allowlist', () => {
        for (const { rel, code } of routeFiles) {
            if (ALLOWLIST.has(rel)) continue;
            const offender = findRawSessionUse(code);
            it(rel, () => {
                // The asserted value carries the actionable message (jest has no
                // expect-message arg), so a failure prints file + token + fix.
                expect(offender ? `${rel} imports/uses \`${offender}\`. ${FIX_1}` : null).toBeNull();
            });
        }
    });

    describe('rule 2 — every prisma route enters through a sanctioned wrapper', () => {
        for (const { rel, code } of routeFiles) {
            if (ALLOWLIST.has(rel)) continue;
            const violations = findUnwrappedPrismaHandlers(code);
            const msg = violations.length
                ? `${rel} touches prisma but: ${violations.join('; ')}. ` +
                  `Each exported handler must be wrapped in ${WRAPPERS}, or be a ` +
                  `public-read via getOptionalSessionUser/authenticateRequest, or be allowlisted.`
                : null;
            it(rel, () => {
                expect(msg).toBeNull();
            });
        }
    });

    describe('rule 3 — edge-sensitive reads in GET/HEAD must be allowlisted', () => {
        it('resolves relation keys parent-aware via the map', () => {
            // The whole point: resolve each key by enclosing model. If this map
            // shape changes, the parent-aware walk's assumptions broke.
            expect(REL.Program?.participants?.model).toBe('ProgramParticipant'); // edge
            expect(REL.Household?.householdMembers?.model).toBe('Person'); // not edge
        });

        for (const { rel, code } of routeFiles) {
            if (ALLOWLIST.has(rel)) continue;
            const key = rel.replace(/\/route\.ts$/, '');
            const edges = findEdgeReadsInReads(code);
            const msg =
                edges.length && !(key in EDGE_INCLUDE_ALLOWLIST)
                    ? `Route ${key} includes edge model(s) ${edges.join(', ')}. ${FIX_3}`
                    : null;
            it(rel, () => {
                expect(msg).toBeNull();
            });
        }

        it('every EDGE_INCLUDE_ALLOWLIST entry is still a live includer (no dead exemptions)', () => {
            const flagged = new Set(
                routeFiles
                    .filter(({ code }) => findEdgeReadsInReads(code).length > 0)
                    .map(({ rel }) => rel.replace(/\/route\.ts$/, '')),
            );
            const dead = Object.keys(EDGE_INCLUDE_ALLOWLIST).filter((k) => !flagged.has(k));
            expect(dead).toEqual([]);
        });
    });

    describe('rule 4 — getOptionalSessionUser callers must gate ops-stg or be allowlisted', () => {
        for (const { rel, code } of routeFiles) {
            if (ALLOWLIST.has(rel)) continue;
            if (!callsGetOptionalSessionUser(code)) continue;
            const msg = hasStagingGateCheck(code) ? null : `${rel}: ${FIX_4}`;
            it(rel, () => {
                expect(msg).toBeNull();
            });
        }

        it('has at least one real getOptionalSessionUser caller to scan (rule is not vacuous)', () => {
            expect(routeFiles.some(({ code }) => callsGetOptionalSessionUser(code))).toBe(true);
        });
    });
});

// The guard must BITE, not just pass vacuously. These assert the detectors on
// synthetic route strings so a future refactor that neuters them is caught.
describe('route auth drift-guard — detectors catch violations', () => {
    it('flags a getServerSession import', () => {
        const synthetic = `import { getServerSession } from "next-auth/next";\nexport const GET = handler('x', async () => {});`;
        expect(findRawSessionUse(stripComments(synthetic))).toBe('getServerSession');
    });

    it('flags an authOptions import', () => {
        expect(findRawSessionUse(stripComments(`import { authOptions } from "@/lib/auth-options";`))).toBe('authOptions');
    });

    it('does NOT flag getServerSession mentioned only in a comment', () => {
        const synthetic = `// a raw getServerSession would let a denied member read\nexport const GET = withAuth({}, async () => {});`;
        expect(findRawSessionUse(stripComments(synthetic))).toBeNull();
    });

    it('flags a bare prisma handler with no wrapper', () => {
        const synthetic = `import prisma from "@/lib/prisma";\nexport async function GET() { return prisma.x.findMany(); }`;
        expect(findUnwrappedPrismaHandlers(stripComments(synthetic))).toHaveLength(1);
    });

    it('flags a const export assigned to a non-wrapper', () => {
        const synthetic = `import prisma from "@/lib/prisma";\nexport const GET = somethingElse(async () => prisma.x);`;
        expect(findUnwrappedPrismaHandlers(stripComments(synthetic))).toHaveLength(1);
    });

    it('accepts a withAuth-wrapped prisma handler (incl. generics)', () => {
        const synthetic = `import prisma from "@/lib/prisma";\nexport const PATCH = withAuth<{ params: Promise<{ id: string }> }>({}, async () => prisma.x);`;
        expect(findUnwrappedPrismaHandlers(stripComments(synthetic))).toEqual([]);
    });

    it('accepts a bare prisma handler that is a getOptionalSessionUser public-read', () => {
        const synthetic = `import prisma from "@/lib/prisma";\nimport { getOptionalSessionUser } from "@/lib/auth";\nexport async function GET(req) { const u = await getOptionalSessionUser(req); return prisma.x; }`;
        expect(findUnwrappedPrismaHandlers(stripComments(synthetic))).toEqual([]);
    });

    it('ignores a route that never touches prisma', () => {
        const synthetic = `export async function GET() { return Response.json({ ok: true }); }`;
        expect(findUnwrappedPrismaHandlers(stripComments(synthetic))).toEqual([]);
    });

    it('flags a direct edge-model read in a GET handler', () => {
        const synthetic = `export const GET = withAuth({}, async () => prisma.visit.findMany());`;
        expect(findEdgeReadsInReads(stripComments(synthetic))).toContain('Visit');
    });

    it('flags an edge relation include in a GET handler', () => {
        const synthetic = `export const GET = handler('x', async () => prisma.program.findUnique({ include: { volunteers: true } }));`;
        expect(findEdgeReadsInReads(stripComments(synthetic))).toContain('ProgramVolunteer');
    });

    // The forward-looking #575 case: a NEW route including Program.participants
    // must be caught even though `participants` is a shared key. A flat key match
    // that excluded the ambiguous key would MISS this — the whole reason for the
    // parent-aware walk.
    it('flags Program.participants include in a GET handler (the #575 leak class)', () => {
        const synthetic = `export const GET = handler('x', async () => prisma.program.findUnique({ include: { participants: { include: { participant: true } } } }));`;
        expect(findEdgeReadsInReads(stripComments(synthetic))).toContain('ProgramParticipant');
    });

    it('flags a nested edge include (event → program → volunteers)', () => {
        const synthetic = `export const GET = withAuth({}, async () => prisma.event.findUnique({ include: { program: { include: { volunteers: true } } } }));`;
        expect(findEdgeReadsInReads(stripComments(synthetic))).toContain('ProgramVolunteer');
    });

    it('flags an edge _count in a GET handler (roster size)', () => {
        const synthetic = `export const GET = withAuth({}, async () => prisma.program.findMany({ include: { _count: { select: { volunteers: true } } } }));`;
        expect(findEdgeReadsInReads(stripComments(synthetic))).toContain('ProgramVolunteer');
    });

    it('does NOT flag an edge read in a write handler (POST — GAP-2, not rule 3)', () => {
        const synthetic = `export const POST = withAuth({}, async () => { await prisma.rSVP.create({ data: {} }); return prisma.programParticipant.findUnique({}); });`;
        expect(findEdgeReadsInReads(stripComments(synthetic))).toEqual([]);
    });

    it('does NOT flag Household.householdMembers (resolves to Person — not edge)', () => {
        const synthetic = `export const GET = withAuth({}, async () => prisma.household.findUnique({ include: { householdMembers: true } }));`;
        expect(findEdgeReadsInReads(stripComments(synthetic))).toEqual([]);
    });

    it('does NOT flag an edge relation used only as a where-filter (no rows returned)', () => {
        const synthetic = `export const GET = withAuth({}, async () => prisma.person.findMany({ where: { programParticipants: { some: { programId: 1 } } } }));`;
        expect(findEdgeReadsInReads(stripComments(synthetic))).toEqual([]);
    });

    it('flags a getOptionalSessionUser caller with no isStaging() check (rule 4)', () => {
        const synthetic = `import { getOptionalSessionUser } from "@/lib/auth";\nexport async function GET(req) { const user = await getOptionalSessionUser(req); return Response.json({ user }); }`;
        expect(callsGetOptionalSessionUser(stripComments(synthetic))).toBe(true);
        expect(hasStagingGateCheck(stripComments(synthetic))).toBe(false);
    });

    it('does NOT flag a getOptionalSessionUser caller that checks config.isStaging() (rule 4)', () => {
        const synthetic = `import { getOptionalSessionUser } from "@/lib/auth";\nimport { config } from "@/lib/config";\nexport async function GET(req) { const user = await getOptionalSessionUser(req); if (config.isStaging() && !user) return apiError("Unauthorized", 401); }`;
        expect(hasStagingGateCheck(stripComments(synthetic))).toBe(true);
    });

    it('does NOT flag a route that only calls authenticateRequest, not getOptionalSessionUser (rule 4 scope)', () => {
        const synthetic = `import { authenticateRequest } from "@/lib/auth";\nexport async function GET(req) { const auth = await authenticateRequest(req); return Response.json({}); }`;
        expect(callsGetOptionalSessionUser(stripComments(synthetic))).toBe(false);
    });

    it('ignores a mention of isStaging in a comment (comments already stripped)', () => {
        const synthetic = `import { getOptionalSessionUser } from "@/lib/auth";\n// TODO: check config.isStaging() here\nexport async function GET(req) { const user = await getOptionalSessionUser(req); }`;
        expect(hasStagingGateCheck(stripComments(synthetic))).toBe(false);
    });
});
