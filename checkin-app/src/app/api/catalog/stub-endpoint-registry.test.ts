import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getRoute } from '@/security/core';
import '@/security/registry';

/**
 * Guard for the class of bug that shipped in the first catalog stub sweep: a
 * re-export stub called `handler("GET /api/items", …)` while the file lived at
 * /api/catalog/items — so getRoute() missed the registry entry and every route
 * 500'd at runtime. tsc can't see it (it's a string literal) and
 * check-route-coverage keys on the FILE path, not the handler() argument, so
 * nothing caught it until a flow test hit the route.
 *
 * This asserts, for every catalog stub, that each `handler("<VERB> <path>")`
 * endpoint (1) equals the URL the file is actually mounted at, and (2) resolves
 * to a registered route. Either mismatch is a guaranteed runtime 500.
 */
const CATALOG_DIR = join(__dirname);
const VERB_HANDLER_RE = /export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*handler\(\s*["']([^"']+)["']/g;

function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...routeFiles(full));
        else if (entry.name === 'route.ts') out.push(full);
    }
    return out;
}

// /api/<path under src/app/api> — mirrors check-route-coverage's fileToEndpointPath.
function urlPath(file: string): string {
    const rel = file.slice(file.indexOf('/src/app/api/') + '/src/app/api/'.length, -'/route.ts'.length);
    return '/api/' + rel;
}

describe('catalog stub endpoints match their file path and the registry', () => {
    const files = routeFiles(CATALOG_DIR);

    it('finds the generated stub tree', () => {
        expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
        const content = readFileSync(file, 'utf8');
        const expectedPath = urlPath(file);
        let m: RegExpExecArray | null;
        VERB_HANDLER_RE.lastIndex = 0;
        while ((m = VERB_HANDLER_RE.exec(content)) !== null) {
            const [, verb, endpoint] = m;
            it(`${endpoint} is mounted at its file path and registered`, () => {
                expect(endpoint).toBe(`${verb} ${expectedPath}`);
                expect(getRoute(endpoint)).toBeDefined();
            });
        }
    }
});
