#!/usr/bin/env ts-node
/**
 * CI lint — verifies the security policy layer can't be routed around.
 *
 * Checks (advisory in Sprint 1; flipped to blocking in Sprint 4):
 *   1. Every src/app/api/<x>/route.ts file exports HTTP verbs registered in src/security/registry.ts
 *      (or a per-library module under src/security/registry/) — by defineRoute, or by
 *      defineFileRoute for a file route served through fileHandler().
 *   2. Every registry entry corresponds to an existing route file.
 *   3. Migrated routes (listed in scripts/migrated-routes.txt) must NOT call NextResponse.json / Response.json directly.
 *   4. Calls to third-party hosts (shopify.com, myshopify.com, resend.com, SHOPIFY_STORE_DOMAIN) live only in src/lib/shopify.ts and src/lib/email.ts.
 *   5. src/security/generated/classifications.ts is up to date with prisma/schema.prisma.
 *   6. RATCHET (blocking even in advisory mode): every exported route method is
 *      either in src/security/registry.ts or in the frozen legacy baseline
 *      (scripts/legacy-authz-routes.txt) — no NEW route can ship on old authz.
 *   7. Routes with NO registered verb must not use bare `include: { rel: true }`
 *      — with no handler() response stripper in front of them, every column of
 *      the related model reaches the wire (see 62dd6d80, GET /api/household).
 *
 * Uses string/regex parsing — fast, no AST library to load. Trade-off: a
 * sufficiently-obfuscated bypass slips past, but this lint is one layer
 * among three (CODEOWNERS + contract tests + lint).
 *
 * Run with: npm run check-route-coverage
 * Exit code in default (advisory) mode: 0 even on errors (warnings printed).
 * Pass --strict to fail the build on any error.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..');
const API_DIR = path.join(REPO_ROOT, 'src/app/api');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const ADVISORY_MODE = !process.argv.includes('--strict');

const ALLOWED_DIRECT_JSON_FILES = new Set<string>([
    path.join(REPO_ROOT, 'src/lib/api-response.ts'),
    path.join(REPO_ROOT, 'src/security/handler.ts'),
]);

const ALLOWED_THIRD_PARTY_FETCH_FILES = new Set<string>([
    path.join(REPO_ROOT, 'src/lib/shopify.ts'),
    path.join(REPO_ROOT, 'src/lib/email.ts'),
]);

const THIRD_PARTY_HOST_RE = /(shopify\.com|myshopify\.com|resend\.com|SHOPIFY_STORE_DOMAIN)/;
const VERB_EXPORT_RE = /export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
/** `export { a as GET, POST }` — each specifier exports its `as` alias, else its own name. */
const EXPORT_LIST_RE = /export\s*\{([^}]*)\}/g;
const EXPORT_SPECIFIER_RE = /^[A-Za-z_$][\w$]*(?:\s+as\s+([A-Za-z_$][\w$]*))?$/;
const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** A registry entry for an endpoint: a JSON route or a file route. */
export const REGISTRY_ENTRY_RE = /define(?:File)?Route\s*\(\s*\{\s*endpoint\s*:\s*['"]([^'"]+)['"]/;
const JSON_CALL_RE = /\b(NextResponse|Response)\.json\s*\(/;

/**
 * Rule 7 parser. A `x: true` leg inside `select: {}` is how you NARROW a query
 * and is everywhere; the same leg inside `include: {}` pulls whole rows. So the
 * only thing that matters is the NEAREST enclosing block kind, tracked through
 * nested braces — the dangerous shape is routinely nested inside a safe one:
 *
 *   include: { household: { include: { householdMembers: true },   // <- flagged
 *                           select:  { id: true } } }              // <- not
 *
 * `_count` legs are exempt: `_count: { select: {...} }` returns integers.
 *
 * ponytail: brace counting, not an AST (see the header's no-AST trade-off).
 * Known ceiling — an unbalanced `{` inside a string literal would skew the
 * stack. `${...}` interpolation is balanced so it self-corrects; comments are
 * blanked below. Reach for an AST only if that ceiling is actually hit.
 */
const BLOCK_KEY_RE = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*$/;
const BARE_TRUE_LEG_RE = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*true\b/y;

/** Blank out comment bodies, preserving offsets and line count. Line comments
 *  only when the `//` starts the line, so `'https://…'` survives intact. */
function blankComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '))
        .replace(/^[ \t]*\/\/[^\n]*/gm, c => ' '.repeat(c.length));
}

export function findBareIncludeLegs(source: string): { name: string; line: number }[] {
    const src = blankComments(source);
    const hits: { name: string; line: number }[] = [];
    const stack: string[] = [];
    let line = 1;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (ch === '\n') { line++; continue; }
        if (ch === '{') {
            const m = BLOCK_KEY_RE.exec(src.slice(Math.max(0, i - 200), i));
            stack.push(m ? m[1] : '');
            continue;
        }
        if (ch === '}') { stack.pop(); continue; }
        if (stack[stack.length - 1] !== 'include') continue;
        if (i > 0 && /[A-Za-z0-9_$.]/.test(src[i - 1])) continue; // mid-identifier
        BARE_TRUE_LEG_RE.lastIndex = i;
        const leg = BARE_TRUE_LEG_RE.exec(src);
        if (!leg) continue;
        if (leg[1] !== '_count') hits.push({ name: leg[1], line });
        i = BARE_TRUE_LEG_RE.lastIndex - 1;
    }
    return hits;
}

/** Rule 7's gate: registered verbs go through handler(), whose response stripper
 *  enforces the tier policy regardless of what the query fetched — a bare
 *  `household: true` there is safe. A route with NO registered verb has no
 *  stripper, so whatever the include pulled reaches the wire as-is. */
export function findUnregisteredBareIncludeLegs(
    content: string, verbs: string[], endpointPath: string, registered: Set<string>,
): { name: string; line: number }[] {
    if (verbs.length === 0 || verbs.some(v => registered.has(`${v} ${endpointPath}`))) return [];
    return findBareIncludeLegs(content);
}

export interface Finding {
    severity: 'error' | 'warn';
    rule: string;
    file: string;
    line?: number;
    message: string;
}
const findings: Finding[] = [];
function report(severity: Finding['severity'], rule: string, file: string, message: string, line?: number) {
    findings.push({ severity, rule, file, line, message });
}

/** Registry entries no route method serves, split by which half is missing.
 *  No route FILE is the sanctioned register-first state — inert, nothing serves
 *  the endpoint — so it warns. A file that exists but no longer exports the verb
 *  is live policy/code drift, so it blocks. */
export function findOrphanRegistryEntries(
    registered: Iterable<string>,
    routeMethods: ReadonlySet<string>,
    routePaths: ReadonlySet<string>,
): Finding[] {
    return Array.from(registered)
        .filter(key => !routeMethods.has(key))
        .map(key => {
            const [method, routePath] = key.split(' ');
            const stale = routePaths.has(routePath);
            return {
                severity: stale ? ('error' as const) : ('warn' as const),
                rule: 'orphan-registry',
                file: 'src/security/registry.ts',
                message: stale
                    ? `registry entry ${key} is stale — ${routePath} has a route file, but it ` +
                      `exports no ${method}. Drop the entry, or restore the export.`
                    : `registry entry ${key} has no route file at ${routePath} — the ` +
                      `register-first state while its route PR is pending.`,
            };
        });
}

function loadMigratedRoutes(): Set<string> {
    const file = path.join(REPO_ROOT, 'scripts/migrated-routes.txt');
    if (!fs.existsSync(file)) return new Set();
    return new Set(
        fs.readFileSync(file, 'utf-8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#')),
    );
}

/**
 * The legacy-authz ratchet baseline: route method keys that predate the
 * registry and are allowed to keep withAuth/withKiosk/withCron/bespoke authz.
 * Frozen; may only shrink (see the file header). A key in NEITHER the
 * registry NOR this file is a NEW route on old authz → hard error, blocking
 * even in advisory mode.
 */
function loadLegacyAuthzRoutes(): Set<string> {
    const file = path.join(REPO_ROOT, 'scripts/legacy-authz-routes.txt');
    if (!fs.existsSync(file)) {
        report('error', 'new-route-old-authz', file,
            'scripts/legacy-authz-routes.txt missing — the legacy-authz ratchet cannot run');
        return new Set();
    }
    return new Set(
        fs.readFileSync(file, 'utf-8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#')),
    );
}

/** The direct-json baseline: `<file> <exact trimmed line>` entries, each
 *  excusing ONE occurrence of that line in that file. Frozen; see its header. */
function loadDirectJsonBaseline(): Map<string, number> {
    const file = path.join(REPO_ROOT, 'scripts/direct-json-baseline.txt');
    if (!fs.existsSync(file)) return new Map();
    return countDirectJsonEntries(fs.readFileSync(file, 'utf-8'));
}

export function countDirectJsonEntries(text: string): Map<string, number> {
    const allowance = new Map<string, number>();
    for (const entry of text.split('\n').map(l => l.trim())) {
        if (entry && !entry.startsWith('#')) allowance.set(entry, (allowance.get(entry) ?? 0) + 1);
    }
    return allowance;
}

/** Direct `.json(` calls in a migrated route, minus baseline-excused ones.
 *  Consumes `allowance` (keyed `<relFile> <trimmed line>`), so an entry still
 *  above zero after every file is scanned is stale. */
export function findDirectJsonCalls(
    relFile: string, content: string, allowance: Map<string, number>,
): { line: number; caller: string }[] {
    const hits: { line: number; caller: string }[] = [];
    content.split('\n').forEach((line, i) => {
        const trimmed = line.trim();
        const m = JSON_CALL_RE.exec(line);
        if (!m || trimmed.startsWith('//')) return;
        const key = `${relFile} ${trimmed}`;
        const left = allowance.get(key) ?? 0;
        if (left > 0) allowance.set(key, left - 1);
        else hits.push({ line: i + 1, caller: m[1] });
    });
    return hits;
}

export function findStaleDirectJsonEntries(allowance: ReadonlyMap<string, number>): Finding[] {
    return Array.from(allowance)
        .filter(([, left]) => left > 0)
        .map(([key, left]) => ({
            severity: 'warn' as const,
            rule: 'stale-direct-json-baseline',
            file: 'scripts/direct-json-baseline.txt',
            message: `baseline entry "${key}" is listed ${left} more time(s) than it matches — remove the line`,
        }));
}

function findRouteFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) findRouteFiles(full, out);
        else if (entry.name === 'route.ts' || entry.name === 'route.tsx') out.push(full);
    }
    return out;
}

function fileToEndpointPath(file: string): string {
    const rel = path.relative(API_DIR, path.dirname(file));
    return '/api' + (rel ? '/' + rel : '');
}

export function extractExportedVerbs(content: string): string[] {
    const found = new Set<string>();
    for (const m of content.matchAll(VERB_EXPORT_RE)) found.add(m[1]);
    for (const list of content.matchAll(EXPORT_LIST_RE)) {
        for (const spec of list[1].split(',')) {
            const s = EXPORT_SPECIFIER_RE.exec(spec.trim());
            const name = s && (s[1] ?? spec.trim());
            if (name && HTTP_VERBS.has(name)) found.add(name);
        }
    }
    return Array.from(found);
}

function loadRegisteredEndpoints(): { routes: Set<string>; outbounds: Set<string> } {
    // Parse the registry files directly rather than evaluating them — keeps this
    // lint independent of module-resolution quirks. The registry follows a
    // strict shape: defineRoute({ endpoint: '...' }) / defineFileRoute({ endpoint: '...' }) /
    // defineOutbound({ surface: '...' }).
    // registry.ts aggregates the per-library modules under registry/.
    const registryPath = path.join(REPO_ROOT, 'src/security/registry.ts');
    const libRegistryDir = path.join(REPO_ROOT, 'src/security/registry');
    const routes = new Set<string>();
    const outbounds = new Set<string>();
    if (!fs.existsSync(registryPath)) {
        report('error', 'registry-load', registryPath, 'registry.ts not found');
        return { routes, outbounds };
    }
    const libRegistryPaths = fs.existsSync(libRegistryDir)
        ? fs.readdirSync(libRegistryDir).filter(f => f.endsWith('.ts')).map(f => path.join(libRegistryDir, f))
        : [];
    const content = [registryPath, ...libRegistryPaths].map(p => fs.readFileSync(p, 'utf-8')).join('\n');
    const routeRe = new RegExp(REGISTRY_ENTRY_RE.source, 'g');
    const outboundRe = /defineOutbound\s*\(\s*\{\s*surface\s*:\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = routeRe.exec(content)) !== null) routes.add(m[1]);
    while ((m = outboundRe.exec(content)) !== null) outbounds.add(m[1]);
    return { routes, outbounds };
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkTsFiles(full, out);
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
}

function checkGeneratedFileFresh() {
    try {
        execSync('git diff --exit-code src/security/generated/classifications.ts', {
            cwd: REPO_ROOT,
            stdio: 'pipe',
        });
    } catch {
        report('error', 'stale-generated', 'src/security/generated/classifications.ts',
            'generated file is dirty — run `npx prisma generate` and commit');
    }
}

function main() {
    const migrated = loadMigratedRoutes();
    const legacyAuthz = loadLegacyAuthzRoutes();
    const directJsonAllowance = loadDirectJsonBaseline();
    const { routes: registered } = loadRegisteredEndpoints();
    const routeFiles = findRouteFiles(API_DIR);

    const allRouteEndpoints = new Set<string>();
    const allRoutePaths = new Set<string>();
    for (const file of routeFiles) {
        const endpointPath = fileToEndpointPath(file);
        allRoutePaths.add(endpointPath);
        const content = fs.readFileSync(file, 'utf-8');
        const verbs = extractExportedVerbs(content);

        const migratedVerbs: string[] = [];
        for (const verb of verbs) {
            const key = `${verb} ${endpointPath}`;
            allRouteEndpoints.add(key);
            if (migrated.has(key)) migratedVerbs.push(verb);
            if (migrated.has(key) && !registered.has(key)) {
                report('error', 'missing-registry', file, `migrated route ${key} not in registry`);
            }
            // The legacy-authz ratchet: a route method in neither the registry
            // nor the frozen baseline is NEW surface on old authz. New routes
            // go through defineRoute() + handler() — see legacy-authz-routes.txt.
            if (!registered.has(key) && !legacyAuthz.has(key)) {
                report('error', 'new-route-old-authz', file,
                    `${key} is not in the security registry and not in the frozen ` +
                    `legacy baseline (scripts/legacy-authz-routes.txt). New routes must ` +
                    `use defineRoute() + handler() from @/security.`);
            }
        }

        const fullyMigrated = verbs.length > 0 && verbs.every(v => migrated.has(`${v} ${endpointPath}`));
        if (fullyMigrated && !ALLOWED_DIRECT_JSON_FILES.has(file)) {
            for (const hit of findDirectJsonCalls(path.relative(REPO_ROOT, file), content, directJsonAllowance)) {
                report('error', 'direct-json', file,
                    `migrated route uses ${hit.caller}.json() — return ModelBag from handler() body instead`,
                    hit.line);
            }
        }

        // Rule 7. ponytail: warn, not error — there are pre-existing hits and CI
        // runs this with --strict, so error would break main on contact. Flip to
        // 'error' once the hit list reaches zero; that is this one word and no new
        // machinery (deliberately NOT a third baseline file — the warn severity IS
        // the grandfathering, and every scripts/*.txt is CODEOWNERS-gated).
        for (const leg of findUnregisteredBareIncludeLegs(content, verbs, endpointPath, registered)) {
            report('warn', 'bare-include-relation', file,
                `bare 'include: { ${leg.name}: true }' on an unregistered route returns every ` +
                `column of ${leg.name} — use an explicit select, or migrate to handler()`,
                leg.line);
        }

        if (verbs.length > 0 && migratedVerbs.length === 0) {
            report('warn', 'unmigrated', file,
                `route ${verbs.join('/')} ${endpointPath} has not yet been migrated to handler()`);
        } else if (verbs.length > migratedVerbs.length) {
            const unmigrated = verbs.filter(v => !migrated.has(`${v} ${endpointPath}`));
            report('warn', 'partially-migrated', file,
                `verbs ${unmigrated.join(',')} of ${endpointPath} not yet migrated`);
        }
    }

    findings.push(...findOrphanRegistryEntries(registered, allRouteEndpoints, allRoutePaths));
    findings.push(...findStaleDirectJsonEntries(directJsonAllowance));

    // Keep the ratchet honest: a baseline entry whose route no longer exists
    // (deleted or migrated) must be pruned, or a later re-creation of the same
    // METHOD+path would silently inherit its old-authz allowance.
    for (const key of legacyAuthz) {
        if (!allRouteEndpoints.has(key)) {
            report('warn', 'stale-legacy-baseline', 'scripts/legacy-authz-routes.txt',
                `baseline entry ${key} has no corresponding route method — remove the line`);
        }
        if (registered.has(key)) {
            report('warn', 'stale-legacy-baseline', 'scripts/legacy-authz-routes.txt',
                `baseline entry ${key} is now in the security registry — remove the line`);
        }
    }

    const allTs = walkTsFiles(SRC_DIR);
    for (const file of allTs) {
        if (ALLOWED_THIRD_PARTY_FETCH_FILES.has(file)) continue;
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n');
        lines.forEach((line, i) => {
            if (THIRD_PARTY_HOST_RE.test(line) && /\bfetch\b/.test(line)) {
                report('error', 'third-party-fetch', file,
                    `direct fetch to third-party host outside gateway — use outboundCall() instead`,
                    i + 1);
            }
        });
    }

    checkGeneratedFileFresh();

    const errors = findings.filter(f => f.severity === 'error');
    const warnings = findings.filter(f => f.severity === 'warn');

    for (const f of findings) {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        const tag = f.severity === 'error' ? '✗' : '⚠';
        console.log(`${tag} [${f.rule}] ${loc} — ${f.message}`);
    }
    console.log('');
    console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);

    if (errors.length > 0) {
        // The legacy-authz ratchet blocks unconditionally — advisory mode was
        // the migration on-ramp for EXISTING routes, and grandfathering is the
        // baseline file's job. A new route on old authz has no advisory tier.
        const ratchet = errors.filter(f => f.rule === 'new-route-old-authz');
        if (ADVISORY_MODE && ratchet.length === 0) {
            console.log('(advisory mode — exiting 0; pass --strict to fail the build)');
            process.exit(0);
        }
        if (ADVISORY_MODE) {
            console.log(`(${ratchet.length} new-route-old-authz error(s) block even in advisory mode)`);
        }
        process.exit(1);
    }
    process.exit(0);
}

// Guarded so the rule-7 parser above can be imported by its test without
// running the whole lint (and its process.exit) on import.
if (require.main === module) main();
