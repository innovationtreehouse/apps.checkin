import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getFileRoute, getRoute } from '@/security/core';
import '@/security/registry';

/**
 * Guard for a re-export stub whose handler() string names the wrong path:
 * `handler("GET /api/items", …)` in a file at /api/catalog/items makes getRoute()
 * miss the registry entry, so the route 500s at runtime. tsc can't see it (it's a
 * string literal) and check-route-coverage keys on the FILE path, not the
 * handler() argument.
 *
 * This asserts, for every library stub under a libraries.json route prefix, that
 * each `handler("<VERB> <path>")` or `fileHandler("<VERB> <path>")` endpoint
 * (1) equals the URL the file is actually mounted at, and (2) resolves to a
 * route in its wrapper's registry. Either mismatch is a guaranteed runtime 500.
 */
const libraries: Array<{ name: string; routePrefixes: string[] }> = JSON.parse(
    readFileSync(join(__dirname, '../../../libraries.json'), 'utf8'),
);
const VERB_HANDLER_RE = /export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*(handler|fileHandler)(?:<[^>]*>)?\(\s*["']([^"']+)["']/g;

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

for (const lib of libraries) {
    for (const prefix of lib.routePrefixes) {
        describe(`${lib.name} stub endpoints under ${prefix} match their file path and the registry`, () => {
            const files = routeFiles(join(__dirname, prefix.replace(/^\/api\//, '')));

            it('finds the generated stub tree', () => {
                expect(files.length).toBeGreaterThan(0);
            });

            for (const file of files) {
                const content = readFileSync(file, 'utf8');
                const expectedPath = urlPath(file);
                const endpoints = [...content.matchAll(VERB_HANDLER_RE)];

                it(`${expectedPath} declares its verbs through handler() or fileHandler()`, () => {
                    expect(endpoints.length).toBeGreaterThan(0);
                });

                for (const [, verb, wrapper, endpoint] of endpoints) {
                    it(`${endpoint} is mounted at its file path and registered`, () => {
                        expect(endpoint).toBe(`${verb} ${expectedPath}`);
                        const lookup = wrapper === 'fileHandler' ? getFileRoute : getRoute;
                        expect(lookup(endpoint)).toBeDefined();
                    });
                }
            }
        });
    }
}
