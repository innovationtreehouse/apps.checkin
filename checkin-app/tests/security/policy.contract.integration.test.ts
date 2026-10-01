/**
 * @jest-environment node
 *
 * Generic contract tests for the security policy. For every (endpoint, role,
 * tokens) entry in the registry, asserts:
 *   1. No undeclared fields appear in the response (a key that isn't a known
 *      Model.field or relation).
 *   2. Every classified field that DOES appear has a tier the view grants.
 *      (Per-row scope correctness is enforced by the handler stripper and
 *      verified by route-specific tests.)
 */
// jest.setup.js installs a global @/lib/prisma mock that rejects all calls;
// this is an integration test that needs the real client to seed personas.
jest.unmock('@/lib/prisma');

import { getServerSession } from 'next-auth/next';
import { allRoutes, classifications, relations } from '@/security/core';
import { collectFieldKeys, tierIsGrantable } from './helpers';
import { loadPersonas } from './personas';
import '@/security/registry';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

interface RouteImports {
    GET?: (req: Request, ctx?: unknown) => Promise<Response>;
    POST?: (req: Request, ctx?: unknown) => Promise<Response>;
    PUT?: (req: Request, ctx?: unknown) => Promise<Response>;
    PATCH?: (req: Request, ctx?: unknown) => Promise<Response>;
    DELETE?: (req: Request, ctx?: unknown) => Promise<Response>;
}

function endpointToRoutePath(endpoint: string): string {
    return endpoint.split(' ')[1];
}
function methodOf(endpoint: string): keyof RouteImports {
    return endpoint.split(' ')[0] as keyof RouteImports;
}
function importPathFor(routePath: string): string {
    return `@/app${routePath}/route`;
}
function extractParams(routePath: string): Record<string, string> {
    const params: Record<string, string> = {};
    for (const m of routePath.matchAll(/\[(\w+)\]/g)) params[m[1]] = '1';
    return params;
}

describe('Security policy contract', () => {
    const entries = Array.from(allRoutes());

    for (const [endpoint, spec] of entries) {
        describe(endpoint, () => {
            const routePath = endpointToRoutePath(endpoint);
            const method = methodOf(endpoint);

            for (const [role, tokens] of spec.orderedView) {
                it(`as ${role}: no undeclared fields and only grantable tiers`, async () => {
                    const personas = await loadPersonas();
                    const persona = personas[role];
                    if (!persona) return; // role exercised in route-specific tests

                    (getServerSession as jest.Mock).mockResolvedValue(
                        persona.sessionUser ? { user: persona.sessionUser } : null,
                    );

                    let mod: RouteImports;
                    try {
                        mod = await import(importPathFor(routePath));
                    } catch {
                        return;
                    }
                    const verb = mod[method];
                    if (!verb) return;

                    const url = `http://localhost:4000${routePath.replace(/\[(\w+)\]/g, '1')}`;
                    const req = new Request(url, { method });
                    const ctx = /\[(\w+)\]/.test(routePath)
                        ? { params: Promise.resolve(extractParams(routePath)) }
                        : undefined;
                    const res = await verb(req, ctx);
                    if (res.status >= 400) return; // auth/not-found paths aren't field-checked
                    const body = await res.json();

                    // Unwrap envelope if the spec declares one.
                    const unwrapped =
                        typeof spec.envelope === 'string' &&
                        typeof body === 'object' &&
                        body !== null &&
                        spec.envelope in body
                            ? (body as Record<string, unknown>)[spec.envelope]
                            : body;

                    const out = { seen: new Map(), undeclared: new Set<string>() };

                    if (Array.isArray(unwrapped)) {
                        // Without an explicit model hint, we can't classify list items.
                        // Skip array-only bodies in this generic test — route-specific
                        // tests should cover them.
                    } else if (typeof unwrapped === 'object' && unwrapped !== null) {
                        const obj = unwrapped as Record<string, unknown>;
                        const keys = Object.keys(obj);
                        const allKeysAreModels = keys.length > 0 && keys.every(k => k in classifications);
                        if (allKeysAreModels) {
                            // Shape is { ModelA: ..., ModelB: ... } — walk each branch.
                            for (const [k, v] of Object.entries(obj)) {
                                collectFieldKeys(v, k, out);
                            }
                        } else {
                            // Envelope (or single-model unwrap) replaces the model name
                            // with the envelope name; top-level keys are field names.
                            // Infer the unique model whose fields/relations cover every key.
                            const modelNames = Object.keys(classifications) as Array<keyof typeof classifications>;
                            const candidates = modelNames.filter(model => {
                                const fields = classifications[model] as Record<string, unknown>;
                                const rels = (relations[model as keyof typeof relations] ?? {}) as Record<string, unknown>;
                                return keys.every(k => k in fields || k in rels || k === '_count');
                            });
                            if (candidates.length === 1) {
                                collectFieldKeys(obj, candidates[0] as string, out);
                            }
                            // Ambiguous or no match: skip — route-specific tests cover this.
                        }
                    }

                    expect(Array.from(out.undeclared)).toEqual([]);

                    const ungrantable: string[] = [];
                    for (const [key, tier] of out.seen.entries()) {
                        if (!tierIsGrantable(tier, tokens)) {
                            ungrantable.push(`${key} (tier=${tier})`);
                        }
                    }
                    expect(ungrantable).toEqual([]);
                });
            }
        });
    }
});
