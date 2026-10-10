import {
    countDirectJsonEntries,
    extractExportedVerbs,
    findBareIncludeLegs,
    findDirectJsonCalls,
    findStaleDirectJsonEntries,
    findOrphanRegistryEntries,
    findPackageEgressLines,
    findUnregisteredPackageSurfaces,
    findUnregisteredBareIncludeLegs,
    REGISTRY_ENTRY_RE,
} from "../check-route-coverage";

describe("extractExportedVerbs", () => {
    it("reads declaration exports", () => {
        expect(extractExportedVerbs(`export const GET = h;\nexport async function POST() {}`).sort())
            .toEqual(["GET", "POST"]);
    });

    it("reads an export list with several aliased specifiers", () => {
        expect(extractExportedVerbs(`export { _guardedPATCH as PATCH, _guardedDELETE as DELETE };`).sort())
            .toEqual(["DELETE", "PATCH"]);
    });

    it("reads one local exported under two verbs, and a bare verb specifier", () => {
        expect(extractExportedVerbs(`export { handler as GET, handler as POST };\nexport { PUT };`).sort())
            .toEqual(["GET", "POST", "PUT"]);
    });

    it("ignores non-verb exports and a verb that is only the local name", () => {
        expect(extractExportedVerbs(`export { authOptions };\nexport { GET as helper };`)).toEqual([]);
    });

    it("reads a destructured export, renamed or with a default", () => {
        expect(extractExportedVerbs(`export const { GET, handler: POST, PUT = h } = handlers;`).sort())
            .toEqual(["GET", "POST", "PUT"]);
    });

    it("reads a specifier with a comment beside it", () => {
        expect(extractExportedVerbs(`export { h as GET /* c */, k as POST };`).sort()).toEqual(["GET", "POST"]);
    });

    it("ignores commented-out exports", () => {
        expect(extractExportedVerbs(`// export { GET };\n/* export const POST = h; */`)).toEqual([]);
    });

    it("reads a multi-line export list", () => {
        expect(extractExportedVerbs(`export {\n    a as GET,\n    b as POST,\n};`).sort())
            .toEqual(["GET", "POST"]);
    });
});

describe("direct-json baseline", () => {
    const FILE = "src/app/api/x/route.ts";
    const baseline = () => countDirectJsonEntries(
        `# comment\n\n${FILE} return NextResponse.json({\n`);

    it("excuses the one listed line and leaves no stale entry", () => {
        const allowance = baseline();
        expect(findDirectJsonCalls(FILE, `    return NextResponse.json({\n    ok: 1 });`, allowance)).toEqual([]);
        expect(findStaleDirectJsonEntries(allowance)).toEqual([]);
    });

    it("errors on a second occurrence of the same line", () => {
        const src = `return NextResponse.json({\n});\nreturn NextResponse.json({\n});`;
        expect(findDirectJsonCalls(FILE, src, baseline())).toEqual([{ line: 3, caller: "NextResponse" }]);
    });

    it("does not excuse the line in another file", () => {
        expect(findDirectJsonCalls("src/app/api/y/route.ts", `return NextResponse.json({`, baseline()))
            .toEqual([{ line: 1, caller: "NextResponse" }]);
    });

    it("warns on an entry that matches nothing", () => {
        const allowance = baseline();
        findDirectJsonCalls(FILE, `return Response.json({ a: 1 });`, allowance);
        expect(findStaleDirectJsonEntries(allowance)).toEqual([
            expect.objectContaining({ severity: "warn", rule: "stale-direct-json-baseline" }),
        ]);
    });
});

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

describe("findPackageEgressLines", () => {
    it("flags a QuickBooks host held in a constant, away from any fetch", () => {
        expect(findPackageEgressLines(`const BASE = "https://sandbox-quickbooks.api.intuit.com";\nawait fetch(BASE);`))
            .toEqual([1]);
    });

    it("flags the Anthropic host and an Anthropic SDK import", () => {
        expect(findPackageEgressLines(`import Anthropic from "@anthropic-ai/sdk";\nconst u = "https://api.anthropic.com/v1";`))
            .toEqual([1, 2]);
    });

    it("flags the existing Shopify and Resend hosts", () => {
        expect(findPackageEgressLines(`a("x.myshopify.com");\nb("https://api.resend.com");`)).toEqual([1, 2]);
    });

    it("flags any non-loopback URL, including an unlisted host and a templated one", () => {
        expect(findPackageEgressLines('a("https://www.zohoapis.com/crm");\nb(`https://${shop}/admin`);\nc("http://api.stripe.com");'))
            .toEqual([1, 2, 3]);
    });

    it("ignores a bare scheme prefix and a placeholder", () => {
        expect(findPackageEgressLines(`probe("https://" + host);\n<TextInput placeholder="https://…" />`)).toEqual([]);
    });

    it("allows loopback URLs", () => {
        expect(findPackageEgressLines(`a("http://localhost:8087/cb");\nb("http://127.0.0.1:4000");\nc("http://[::1]:5432");`))
            .toEqual([]);
        expect(findPackageEgressLines(`a("https://localhost.evil.com");`)).toEqual([1]);
    });

    it("ignores comments and look-alike identifiers", () => {
        expect(findPackageEgressLines(`// see quickbooks.api.intuit.com\n/* @anthropic-ai/sdk */\nres.headers.get("intuit_tid");`))
            .toEqual([]);
    });
});

describe("findUnregisteredPackageSurfaces", () => {
    it("errors on a mapped surface with no defineOutbound entry", () => {
        const files = new Map([["q/src/client.ts", ["quickbooks.query", "quickbooks.ghost"]]]);
        const found = findUnregisteredPackageSurfaces(files, new Set(["quickbooks.query"]));
        expect(found.map(f => [f.severity, f.file, f.message.includes("quickbooks.ghost")]))
            .toEqual([["error", "packages/q/src/client.ts", true]]);
    });
});
