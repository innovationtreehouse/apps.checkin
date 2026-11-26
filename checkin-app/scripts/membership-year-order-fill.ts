/**
 * One-off fill of `appliesToYear` on paid joining applications and renewals that
 * have none (docs/in-design/membership-process-year.md, "The order fill"). Each
 * row takes the year of the membership-year variant on its store order, or the
 * year a Board member picks. No year is ever worked out from a date. Read-only
 * against Shopify; writes only `appliesToYear` and its audit row.
 *
 *   npx tsx scripts/membership-year-order-fill.ts                      dry run: order matches + Board list
 *   npx tsx scripts/membership-year-order-fill.ts --write              write the order matches
 *   npx tsx scripts/membership-year-order-fill.ts --picks picks.csv    dry run of the Board's picks
 *   npx tsx scripts/membership-year-order-fill.ts --picks picks.csv --write
 *
 * The picks file is CSV with the header `processId,year,boardPersonId`, one row
 * per application on the Board list.
 */
import { readFileSync } from "fs";
import type { PrismaClient } from "../src/generated/prisma/client";
import { personActor, recordAudit, systemActor, type AuditActor } from "../src/lib/auditActor";
import { config } from "../src/lib/config";
import prisma from "../src/lib/prisma";
import { getAccessToken, shopifyFetch, SHOPIFY_API_VERSION } from "../src/lib/shopify/client";

export type FillDb = Pick<PrismaClient, "orgMembershipProcess" | "membershipYearVariant" | "person" | "$transaction">;

export type Candidate = {
    id: number;
    kind: "INITIAL" | "RENEWAL";
    paidAt: Date;
    shopifyOrderId: string | null;
    householdId: number | null;
    householdName: string | null;
};

/** A line's variant id is null when the variant was deleted from the store. */
export type OrderRead = { found: false } | { found: true; lineVariantIds: (string | null)[] };
export type ReadOrder = (shopifyOrderId: string) => Promise<OrderRead>;

export type ListReason = "no-order" | "order-not-found" | "no-membership-variant" | "several-membership-variants";

export type Resolution =
    | { outcome: "order"; candidate: Candidate; year: number; shopifyOrderId: string; shopifyVariantId: string }
    | { outcome: "listed"; candidate: Candidate; reason: ListReason };

export type BoardPick = { processId: number; year: number; boardPersonId: number };

const PAID_WITHOUT_YEAR = {
    kind: { in: ["INITIAL" as const, "RENEWAL" as const] },
    paidAt: { not: null },
    appliesToYear: null,
};

const PICKS_HEADER = "processId,year,boardPersonId";

const REASON_TEXT: Record<ListReason, string> = {
    "no-order": "no store order recorded",
    "order-not-found": "Shopify can't find the order",
    "no-membership-variant": "no membership-year variant on the order",
    "several-membership-variants": "several membership-year variants on the order",
};

export async function loadCandidates(db: FillDb): Promise<Candidate[]> {
    const rows = await db.orgMembershipProcess.findMany({
        where: PAID_WITHOUT_YEAR,
        select: { id: true, kind: true, paidAt: true, shopifyOrderId: true, orgMembership: { select: { household: { select: { id: true, name: true } } } } },
        orderBy: { id: "asc" },
    });
    return rows.flatMap((r) => {
        if (!r.paidAt || (r.kind !== "INITIAL" && r.kind !== "RENEWAL")) return [];
        const household = r.orgMembership?.household ?? null;
        return [{ id: r.id, kind: r.kind, paidAt: r.paidAt, shopifyOrderId: r.shopifyOrderId, householdId: household?.id ?? null, householdName: household?.name ?? null }];
    });
}

/** Membership-year variant id → the year it sells. */
export async function loadVariantYears(db: FillDb): Promise<Map<string, number>> {
    const rows = await db.membershipYearVariant.findMany({ select: { shopifyVariantId: true, membershipYear: true } });
    return new Map(rows.map((r) => [r.shopifyVariantId, r.membershipYear]));
}

/** Resolves one row from its order. Throws when Shopify can't answer, so nothing is listed on a failed read. */
export async function resolveCandidate(candidate: Candidate, variantYears: Map<string, number>, readOrder: ReadOrder): Promise<Resolution> {
    const orderId = candidate.shopifyOrderId?.trim();
    if (!orderId) return { outcome: "listed", candidate, reason: "no-order" };
    if (!/^\d+$/.test(orderId)) return { outcome: "listed", candidate, reason: "order-not-found" };

    const order = await readOrder(orderId);
    if (!order.found) return { outcome: "listed", candidate, reason: "order-not-found" };

    const membershipVariants = [...new Set(order.lineVariantIds.filter((v): v is string => v !== null && variantYears.has(v)))];
    if (membershipVariants.length === 0) return { outcome: "listed", candidate, reason: "no-membership-variant" };
    if (membershipVariants.length > 1) return { outcome: "listed", candidate, reason: "several-membership-variants" };

    const [shopifyVariantId] = membershipVariants;
    const year = variantYears.get(shopifyVariantId);
    if (year === undefined) throw new Error(`variant ${shopifyVariantId} lost its year mid-run`);
    return { outcome: "order", candidate, year, shopifyOrderId: orderId, shopifyVariantId };
}

/** Reads every order before anything is written, so a Shopify failure stops the run with no writes. */
export async function resolveAll(candidates: Candidate[], variantYears: Map<string, number>, readOrder: ReadOrder): Promise<Resolution[]> {
    const resolutions: Resolution[] = [];
    for (const c of candidates) resolutions.push(await resolveCandidate(c, variantYears, readOrder));
    return resolutions;
}

const ORDER_LINES_QUERY = `query OrderLines($id: ID!, $after: String) {
  order(id: $id) {
    lineItems(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { variant { legacyResourceId } }
    }
  }
}`;

type OrderLinesBody = {
    data?: {
        order: {
            lineItems: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: { variant: { legacyResourceId: string } | null }[];
            };
        } | null;
    };
    errors?: { message?: string }[];
};

export type GraphqlPost = (query: string, variables: Record<string, unknown>) => Promise<OrderLinesBody>;

/** Reads every line of an order, page by page, through the Admin GraphQL API. */
export function orderReader(post: GraphqlPost): ReadOrder {
    return async (shopifyOrderId) => {
        const lineVariantIds: (string | null)[] = [];
        let after: string | null = null;
        for (;;) {
            const body: OrderLinesBody = await post(ORDER_LINES_QUERY, { id: `gid://shopify/Order/${shopifyOrderId}`, after });
            if (body.errors?.length) throw new Error(`Shopify order ${shopifyOrderId} read failed: ${body.errors[0].message ?? "unknown error"}`);
            const order = body.data?.order;
            if (!order) {
                if (lineVariantIds.length > 0) throw new Error(`Shopify order ${shopifyOrderId} vanished while its lines were read`);
                return { found: false };
            }
            for (const node of order.lineItems.nodes) lineVariantIds.push(node.variant?.legacyResourceId ?? null);
            const { hasNextPage, endCursor } = order.lineItems.pageInfo;
            if (!hasNextPage) return { found: true, lineVariantIds };
            if (!endCursor) throw new Error(`Shopify order ${shopifyOrderId} reported more lines with no cursor`);
            after = endCursor;
        }
    };
}

async function shopifyGraphqlPost(query: string, variables: Record<string, unknown>): Promise<OrderLinesBody> {
    const storeDomain = config.shopifyStoreDomain();
    const token = await getAccessToken();
    if (!storeDomain || !token) throw new Error("Shopify isn't configured: SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are required.");
    const res = await shopifyFetch(
        `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token }, body: JSON.stringify({ query, variables }) },
        "Shopify read order lines",
    );
    if (!res.ok) throw new Error(`Shopify order read responded with status ${res.status}`);
    return (await res.json()) as OrderLinesBody;
}

/** Parses the Board's picks file. Throws listing every bad line, so a partly wrong file writes nothing. */
export function parsePicks(text: string): BoardPick[] {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
    if (lines[0]?.replace(/\s/g, "") !== PICKS_HEADER) throw new Error(`The picks file must start with the header "${PICKS_HEADER}".`);

    const errors: string[] = [];
    const picks: BoardPick[] = [];
    const seen = new Set<number>();
    lines.slice(1).forEach((line, i) => {
        const lineNo = i + 2;
        const cells = line.split(",").map((c) => c.trim());
        const nums = cells.map((c) => (/^\d+$/.test(c) ? Number(c) : NaN));
        if (cells.length !== 3 || nums.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
            errors.push(`line ${lineNo}: expected three whole numbers, got "${line}"`);
            return;
        }
        const [processId, year, boardPersonId] = nums;
        if (seen.has(processId)) errors.push(`line ${lineNo}: application ${processId} is picked more than once`);
        seen.add(processId);
        picks.push({ processId, year, boardPersonId });
    });
    if (errors.length) throw new Error(`The picks file has errors:\n  ${errors.join("\n  ")}`);
    return picks;
}

/** Refuses any pick that isn't for a listed row or isn't made by a Board member. Throws listing every refusal. */
export async function checkPicks(db: FillDb, picks: BoardPick[], resolutions: Resolution[]): Promise<void> {
    const listed = new Set(resolutions.filter((r) => r.outcome === "listed").map((r) => r.candidate.id));
    const pickerIds = [...new Set(picks.map((p) => p.boardPersonId))];
    const boardMembers = new Set(
        (await db.person.findMany({ where: { id: { in: pickerIds }, isBoardMember: true }, select: { id: true } })).map((p) => p.id),
    );

    const errors: string[] = [];
    for (const p of picks) {
        if (!listed.has(p.processId)) errors.push(`application ${p.processId} is not on the Board list`);
        if (!boardMembers.has(p.boardPersonId)) errors.push(`person ${p.boardPersonId} (pick for application ${p.processId}) is not a Board member`);
    }
    if (errors.length) throw new Error(`Picks refused, nothing written:\n  ${errors.join("\n  ")}`);
}

/** Writes one row's year with its audit row. False when the row gained a year since it was read. */
async function writeYear(db: FillDb, processId: number, year: number, actor: AuditActor, detail: Record<string, string | number>): Promise<boolean> {
    return db.$transaction(async (tx) => {
        const { count } = await tx.orgMembershipProcess.updateMany({ where: { id: processId, ...PAID_WITHOUT_YEAR }, data: { appliesToYear: year } });
        if (count === 0) return false;
        await recordAudit(tx, actor, {
            action: "EDIT",
            tableName: "OrgMembershipProcess",
            affectedEntityId: processId,
            oldData: { appliesToYear: null },
            newData: { appliesToYear: year, ...detail },
        });
        return true;
    });
}

export function writeOrderMatch(db: FillDb, r: Extract<Resolution, { outcome: "order" }>): Promise<boolean> {
    return writeYear(db, r.candidate.id, r.year, systemActor("migration:membership-year-order-fill"), {
        source: "store order",
        shopifyOrderId: r.shopifyOrderId,
        shopifyVariantId: r.shopifyVariantId,
    });
}

export function writePick(db: FillDb, p: BoardPick): Promise<boolean> {
    return writeYear(db, p.processId, p.year, personActor(p.boardPersonId), { source: "Board pick" });
}

/** The Board list: one line per row the order can't settle. It suggests no year. */
export function formatBoardList(resolutions: Resolution[]): string[] {
    return resolutions.flatMap((r) => {
        if (r.outcome !== "listed") return [];
        const c = r.candidate;
        const household = c.householdId === null ? "household ?" : `household ${c.householdId} (${c.householdName ?? "?"})`;
        const order = c.shopifyOrderId ? `order ${c.shopifyOrderId}` : "no order";
        return [`application ${c.id} | ${household} | ${c.kind} | paid ${c.paidAt.toISOString()} | ${order} | ${REASON_TEXT[r.reason]}`];
    });
}

export type Args = { write: boolean; picksPath: string | null };

export function parseArgs(argv: string[]): Args {
    const args: Args = { write: false, picksPath: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--write") args.write = true;
        else if (argv[i] === "--picks" && argv[i + 1] && !argv[i + 1].startsWith("--")) args.picksPath = argv[++i];
        else throw new Error(`Unknown or incomplete argument "${argv[i]}". Use --write and --picks <file>.`);
    }
    return args;
}

/** Runs the fill and returns its report lines. Writes only when `args.write` is set. */
export async function run(db: FillDb, readOrder: ReadOrder, args: Args, readPicksFile: (path: string) => string): Promise<string[]> {
    const out: string[] = [];
    const candidates = await loadCandidates(db);
    const resolutions = await resolveAll(candidates, await loadVariantYears(db), readOrder);
    const matches = resolutions.filter((r): r is Extract<Resolution, { outcome: "order" }> => r.outcome === "order");
    const boardList = formatBoardList(resolutions);

    out.push(`Paid applications with no appliesToYear: ${candidates.length}`);
    out.push(`Settled by their store order: ${matches.length}`);
    out.push(`On the Board list: ${boardList.length}`);

    if (args.picksPath) {
        const picks = parsePicks(readPicksFile(args.picksPath));
        await checkPicks(db, picks, resolutions);
        out.push("", `Board picks (${picks.length}):`);
        for (const p of picks) out.push(`  application ${p.processId} -> ${p.year}, picked by person ${p.boardPersonId}`);
        if (args.write) {
            let written = 0;
            for (const p of picks) if (await writePick(db, p)) written++;
            out.push(`Wrote ${written} pick(s); ${picks.length - written} skipped because the row already has a year.`);
        }
        const picked = new Set(picks.map((p) => p.processId));
        const unpicked = resolutions.filter((r) => r.outcome === "listed" && !picked.has(r.candidate.id));
        out.push("", `Still on the Board list with no pick: ${unpicked.length}`, ...formatBoardList(unpicked).map((l) => `  ${l}`));
    } else {
        out.push("", "Store-order years:");
        for (const m of matches) out.push(`  application ${m.candidate.id} -> ${m.year} (order ${m.shopifyOrderId}, variant ${m.shopifyVariantId})`);
        if (args.write) {
            let written = 0;
            for (const m of matches) if (await writeOrderMatch(db, m)) written++;
            out.push(`Wrote ${written} year(s); ${matches.length - written} skipped because the row already has a year.`);
        }
        out.push("", `Board list (${boardList.length}): the Board picks each year; the script suggests none.`, ...boardList.map((l) => `  ${l}`));
    }

    if (!args.write) out.push("", "Dry run: nothing written. Re-run with --write to write.");
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    try {
        const lines = await run(prisma, orderReader(shopifyGraphqlPost), args, (path) => readFileSync(path, "utf8"));
        console.log(lines.join("\n"));
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    });
}
