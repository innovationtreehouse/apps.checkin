import {
    findBareIncludeLegs,
    findOrphanRegistryEntries,
    findUnregisteredBareIncludeLegs,
    REGISTRY_ENTRY_RE,
} from "../check-route-coverage";

describe("REGISTRY_ENTRY_RE", () => {
    it.each(["defineRoute", "defineFileRoute"])("reads the endpoint of a %s entry", fn => {
        expect(REGISTRY_ENTRY_RE.exec(`${fn}({\n    endpoint: 'GET /api/x/[id]/file',`)?.[1])
            .toBe("GET /api/x/[id]/file");
    });

    it("does not read an outbound surface as a route", () => {
        expect(REGISTRY_ENTRY_RE.exec(`defineOutbound({ surface: 'shopify.order' })`)).toBeNull();
    });
});

const names = (src: string) => findBareIncludeLegs(src).map(l => l.name);

describe("findBareIncludeLegs", () => {
    it("flags a bare-true leg directly inside include", () => {
        expect(names(`prisma.person.findMany({ include: { rel: true } })`)).toEqual(["rel"]);
    });

    it("ignores a fully-projected query with no include at all", () => {
        expect(names(`prisma.person.findMany({ select: { rel: { select: { id: true } } } })`)).toEqual([]);
    });

    it("ignores a bare-true leg inside select — that is how you narrow a query", () => {
        expect(names(`select: { id: true, name: true, isHouseholdLead: true }`)).toEqual([]);
    });

    it("ignores _count, which returns integers rather than rows", () => {
        expect(names(`include: { _count: { select: { visits: true } } }`)).toEqual([]);
    });

    // The case that actually pins the block-kind tracking: one include block
    // containing a nested-block leg, a nested include, and a nested select.
    it("tracks the nearest enclosing block through nesting", () => {
        const src = `
            include: {
                household: {
                    include: {
                        householdMembers: true,
                    },
                    select: { id: true, name: true },
                },
                _count: { select: { visits: true } },
                orgMembership: true,
            }
        `;
        expect(names(src)).toEqual(["householdMembers", "orgMembership"]);
    });

    it("reports the line of the offending leg", () => {
        expect(findBareIncludeLegs("a\nb\ninclude: {\n  rel: true,\n}")).toEqual([{ name: "rel", line: 4 }]);
    });

    it("does not let braces in a blanked comment skew the brace stack", () => {
        const src = `
            select: {
                // include: { leaked: true
                id: true,
            }
        `;
        expect(names(src)).toEqual([]);
    });

    it("does not match true legs mid-identifier", () => {
        expect(names(`include: { a_rel: true }`)).toEqual(["a_rel"]);
        expect(names(`include: { x.rel: true }`)).toEqual([]);
    });
});

describe("findUnregisteredBareIncludeLegs", () => {
    const BODY = `export async function GET() { return prisma.p.findMany({ include: { rel: true } }) }`;

    it("flags the leg when no verb of the route is registered", () => {
        const legs = findUnregisteredBareIncludeLegs(BODY, ["GET"], "/api/thing", new Set());
        expect(legs.map(l => l.name)).toEqual(["rel"]);
    });

    it("stays silent on a registered route — handler()'s stripper covers it", () => {
        const registered = new Set(["GET /api/thing"]);
        expect(findUnregisteredBareIncludeLegs(BODY, ["GET"], "/api/thing", registered)).toEqual([]);
    });

    it("stays silent on a file that exports no verbs", () => {
        expect(findUnregisteredBareIncludeLegs(BODY, [], "/api/thing", new Set())).toEqual([]);
    });
});

describe("findOrphanRegistryEntries", () => {
    const orphans = (registered: string[], methods: string[], paths: string[]) =>
        findOrphanRegistryEntries(registered, new Set(methods), new Set(paths));

    it("stays silent when a route method serves the entry", () => {
        expect(orphans(["GET /api/thing"], ["GET /api/thing"], ["/api/thing"])).toEqual([]);
    });

    // Severity is the register-first contract: a --strict run only fails on
    // 'error', so an entry whose route file has not landed must be a 'warn'.
    it("warns when no route file exists yet — the register-first state", () => {
        const found = orphans(["PATCH /api/thing/[id]"], [], []);
        expect(found).toHaveLength(1);
        expect(found[0].severity).toBe("warn");
        expect(found[0].rule).toBe("orphan-registry");
        expect(found[0].message).toContain("PATCH /api/thing/[id]");
        expect(found[0].message).toContain("register-first");
    });

    // The other half of the split: policy claims a verb the live file no longer
    // serves. Inert it is not — the ratchet must keep blocking here.
    it("errors when the route file exists but no longer exports the verb", () => {
        const found = orphans(["PATCH /api/thing/[id]"], ["GET /api/thing/[id]"], ["/api/thing/[id]"]);
        expect(found).toHaveLength(1);
        expect(found[0].severity).toBe("error");
        expect(found[0].message).toContain("stale");
        expect(found[0].message).toContain("exports no PATCH");
    });
});
