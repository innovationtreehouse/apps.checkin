/**
 * @jest-environment node
 *
 * Admission-gate (authorize) boundary tests for EVERY registry route.
 *
 * The generic policy.contract test only checks field-stripping for ALLOWED
 * personas — it early-returns on any status >= 400, so nothing there asserts
 * that an anonymous or under-privileged caller is actually REJECTED by the
 * registry-gated routes. This file closes that hole: for each route it drives
 * the REAL handler and asserts the admission gate.
 *
 *   - unauthenticated caller                       -> 401 (gated routes)
 *   - authenticated caller with NONE of the roles  -> 403 (role-gated routes)
 *   - an allowed caller                            -> 2xx (sanity)
 *
 * Table-driven off the live registry: adding a route to registry.ts adds a row
 * here automatically, and the required roles are pulled from the route's
 * `authorize` spec rather than hardcoded. If a route fails to reject an
 * under-privileged caller, the 403 assertion below fails loudly — that is a
 * live authz hole, not a test bug.
 */
// jest.setup.js installs a global @/lib/prisma mock that rejects all calls;
// this is an integration test that needs the real client to seed personas.
jest.unmock('@/lib/prisma');

import * as fs from 'fs';
import * as path from 'path';
import { allRoutes, type Authorize } from '@/security/core';
import type { BusinessRole, AuthenticatedUser } from '@/types/auth';
import prisma from '@/lib/prisma';
import '@/security/registry';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;

const TAG = 'registry-authz-test';

type Gate = 'public' | 'session' | 'household-member' | 'anyRole' | 'certifier' | 'program-scoped' | 'catalog-viewer' | 'inventory-manager' | 'unhandled';

interface RoutePlan {
    endpoint: string;
    method: string;
    routePath: string;
    gate: Gate;
    /** Non-null only for `{ anyRole }` routes — pulled straight from the spec. */
    requiredRoles: BusinessRole[] | null;
}

function planAuthorize(authorize: Authorize): { gate: Gate; requiredRoles: BusinessRole[] | null } {
    if (authorize === 'public') return { gate: 'public', requiredRoles: null };
    if (authorize === 'authenticated' || authorize === 'self') return { gate: 'session', requiredRoles: null };
    if (authorize === 'household-member') return { gate: 'household-member', requiredRoles: null };
    if (authorize === 'certifier') return { gate: 'certifier', requiredRoles: null };
    if (typeof authorize === 'object' && authorize !== null && 'anyRole' in authorize) {
        return { gate: 'anyRole', requiredRoles: [...authorize.anyRole] };
    }
    // Program-scoped gates: resolveAccess admits a lead/core-vol of THIS program
    // OR a sysadmin/board. A plain authenticated user holds neither → 403.
    if (authorize === 'program-lead-mentor' || authorize === 'program-core-volunteer') {
        return { gate: 'program-scoped', requiredRoles: null };
    }
    // Catalog (#1286 §6): 'catalog-viewer' admits any staff relationship (a plain
    // authenticated user is rejected); 'inventory-manager' admits the role only.
    if (authorize === 'catalog-viewer') return { gate: 'catalog-viewer', requiredRoles: null };
    if (authorize === 'inventory-manager') return { gate: 'inventory-manager', requiredRoles: null };
    // household-lead / kiosk: not in the current registry. Surfaced as
    // 'unhandled' so a future route can't be silently skipped — it'll fail the
    // explicit guard test below.
    return { gate: 'unhandled', requiredRoles: null };
}

const PLANS: RoutePlan[] = Array.from(allRoutes()).map(([endpoint, spec]) => {
    const [method, routePath] = endpoint.split(' ');
    return { endpoint, method, routePath, ...planAuthorize(spec.authorize) };
});

function importPathFor(routePath: string): string {
    return `@/app${routePath}/route`;
}

/** A registry entry may legally precede its route file (register-first: an
 *  unused defineRoute is inert). Cases that drive the handler are skipped until
 *  the file lands; a file that exists and then fails to import still throws. */
function routeFileExists(routePath: string): boolean {
    const base = path.resolve(__dirname, `../../src/app${routePath}/route`);
    return ['.ts', '.tsx'].some(ext => fs.existsSync(base + ext));
}

describe('Registry route admission gates', () => {
    let plainUser: AuthenticatedUser;
    let programId: number;
    let eventId: number;
    const householdIds: number[] = [];
    const participantIds: number[] = [];
    const ENV_BEFORE = process.env.CHECKIN_ENV;

    beforeAll(async () => {
        // Never let the local-kiosk fallback (auth.ts) treat a cookieless,
        // unsigned request as kiosk — that would turn our 401 cases into kiosk.
        process.env.CHECKIN_ENV = 'dev';

        const plain = await prisma.person.create({
            data: {
                name: 'Authz Plain',
                email: `plain-${TAG}@example.com`,
                household: { create: { name: `Plain ${TAG}` } },
            },
        });
        participantIds.push(plain.id);
        householdIds.push(plain.householdId);
        plainUser = {
            id: plain.id,
            email: plain.email ?? '',
            householdId: plain.householdId,
            isSysadmin: false,
            isBoardMember: false,
            isKeyholder: false,
            isBackgroundCheckReviewer: false,
            isOperations: false,
            isInventoryManager: false,
        };

        // For the public route's 2xx sanity (programs/[id]). orgMemberOnly defaults
        // false, so an anonymous caller is admitted and sees it.
        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Authz Program ${TAG}` } });
        programId = program.id;

        // For event routes ('GET /api/events/[id]' etc.) whose [id] is an EVENT
        // id, not a program id. Plain authenticated caller is admitted (gate
        // 'session') and the existing event yields a 2xx; the roster is stripped
        // to public for them, which is what the policy intends.
        const event = await prisma.event.create({
            data: { programId, name: `Authz Event ${TAG}`, startAt: new Date(), endAt: new Date() },
        });
        eventId = event.id;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.CHECKIN_ENV = 'dev';
    });

    afterAll(async () => {
        process.env.CHECKIN_ENV = ENV_BEFORE;
        await prisma.event.deleteMany({ where: { id: eventId } });
        await prisma.program.deleteMany({ where: { id: programId } });
        await prisma.person.deleteMany({ where: { id: { in: participantIds } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    async function call(plan: RoutePlan): Promise<Response> {
        const mod = (await import(importPathFor(plan.routePath))) as Record<string, unknown>;
        const verb = mod[plan.method] as ((req: Request, ctx?: unknown) => Promise<Response>) | undefined;
        if (typeof verb !== 'function') {
            throw new Error(`${plan.endpoint}: no ${plan.method} export — registry/route out of sync`);
        }
        // Event routes carry an EVENT id in [id]; everything else uses the
        // program id (the only other seeded resource).
        const idValue = String(plan.routePath.startsWith('/api/events/') ? eventId : programId);
        const url = `http://localhost${plan.routePath.replace(/\[(\w+)\]/g, idValue)}`;
        const hasParams = /\[(\w+)\]/.test(plan.routePath);
        const ctx = hasParams
            ? { params: Promise.resolve(Object.fromEntries(
                  [...plan.routePath.matchAll(/\[(\w+)\]/g)].map(m => [m[1], idValue]),
              )) }
            : undefined;
        return verb(new Request(url, { method: plan.method }), ctx);
    }

    // Guards the skip below: a wrong path would resolve every route as absent
    // and skip the whole file green.
    it('resolves route files on disk', () => {
        expect(PLANS.filter(p => routeFileExists(p.routePath)).length).toBeGreaterThan(0);
    });

    for (const plan of PLANS) {
        describe(plan.endpoint, () => {
            // Every case using this drives the real handler, so it waits for the
            // route file. The gate check below is static and always runs.
            const itServed = routeFileExists(plan.routePath) ? it : it.skip;

            it('has a handled authorize gate (route not silently skipped)', () => {
                expect(plan.gate).not.toBe('unhandled');
            });

            // ── unauthenticated ───────────────────────────────────────────────
            if (plan.gate === 'public') {
                itServed('admits an unauthenticated caller (public route)', async () => {
                    mockSession.mockResolvedValue(null);
                    const res = await call(plan);
                    expect(res.status).toBeLessThan(400);
                });
            } else {
                itServed('rejects an unauthenticated caller with 401', async () => {
                    mockSession.mockResolvedValue(null);
                    expect((await call(plan)).status).toBe(401);
                });
            }

            // ── authenticated but under-privileged ───────────────────────────
            if (plan.gate === 'anyRole') {
                const roles = (plan.requiredRoles ?? []).join(' | ');
                itServed(`rejects an authenticated caller holding none of [${roles}] with 403`, async () => {
                    // plainUser carries every role flag = false → holds none.
                    mockSession.mockResolvedValue({ user: plainUser });
                    expect((await call(plan)).status).toBe(403);
                });
            }
            if (plan.gate === 'certifier') {
                itServed('rejects an authenticated non-certifier (and non-admin) with 403', async () => {
                    // plainUser holds no toolStatuses and no admin flag.
                    mockSession.mockResolvedValue({ user: plainUser });
                    expect((await call(plan)).status).toBe(403);
                });
            }
            if (plan.gate === 'program-scoped') {
                itServed('rejects an authenticated caller who is not a lead of this program with 403', async () => {
                    // plainUser leads no program and is not sysadmin/board.
                    mockSession.mockResolvedValue({ user: plainUser });
                    expect((await call(plan)).status).toBe(403);
                });
            }
            if (plan.gate === 'catalog-viewer' || plan.gate === 'inventory-manager') {
                itServed('rejects an authenticated caller with no catalog access with 403', async () => {
                    // plainUser holds no role flag, leads no program, and has no
                    // VolunteerDesignation — denied by both catalog gates.
                    mockSession.mockResolvedValue({ user: plainUser });
                    expect((await call(plan)).status).toBe(403);
                });
            }
            // session / household-member / public gates have no role-level
            // under-privileged caller — any authenticated (resp. any) caller is
            // admitted by design, so there is no 403 to assert. Field-level
            // scoping for those is covered by policy.contract + route tests.

            // ── allowed (sanity) ─────────────────────────────────────────────
            const admitted = plan.method === 'GET' ? '2xx' : 'not 401/403';
            itServed(`admits an allowed caller (${admitted})`, async () => {
                if (plan.gate === 'public') {
                    mockSession.mockResolvedValue(null);
                } else if (plan.gate === 'anyRole') {
                    const role = (plan.requiredRoles ?? [])[0];
                    mockSession.mockResolvedValue({ user: { ...plainUser, [role]: true } });
                } else if (plan.gate === 'certifier' || plan.gate === 'program-scoped') {
                    // Both gates OR-admit isAdmin in resolveAccess, so an admin is the
                    // simplest allowed caller (no tool-status / lead-mentor seeding needed).
                    mockSession.mockResolvedValue({ user: { ...plainUser, isSysadmin: true } });
                } else if (plan.gate === 'catalog-viewer') {
                    // Any role flag admits the viewer gate; isKeyholder is the simplest.
                    mockSession.mockResolvedValue({ user: { ...plainUser, isKeyholder: true } });
                } else if (plan.gate === 'inventory-manager') {
                    mockSession.mockResolvedValue({ user: { ...plainUser, isInventoryManager: true } });
                } else if (plan.routePath.startsWith('/api/events/')) {
                    // events/[id] is authorize:'authenticated' (so gate 'session'), but the
                    // handler fn adds an inline staff-only roster gate the registry grammar
                    // can't express ([id] is an event id). An admin clears that inline gate.
                    mockSession.mockResolvedValue({ user: { ...plainUser, isSysadmin: true } });
                } else {
                    // session / household-member: any real authenticated user.
                    mockSession.mockResolvedValue({ user: plainUser });
                }
                const res = await call(plan);
                // A write verb can't be driven with an empty body and no owned
                // row, so admission is all that's assertable: a 400 from
                // validation or a 404 from an ownership check both cleared authz.
                if (plan.method === 'GET') expect(res.status).toBeLessThan(400);
                else expect([401, 403]).not.toContain(res.status);
            });
        });
    }
});
