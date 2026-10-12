/**
 * @jest-environment node
 */
/**
 * The reconciler against a REAL `shopify_read` mirror: operator-injected rows
 * (HAND_LOADED / TEST_LOADED) must never activate a membership or enrollment or raise
 * a reversal, while API rows (BACKFILL / INCREMENTAL, or NULL from pre-column sync
 * code) still do. The mirror is a throwaway database on the test server, built from
 * s-ingest-core's own migrations so the column types match production.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import prisma from "@/lib/prisma";
import { snapshotBoardSettings } from "@/test-helpers/boardSettings";
import { runReconcile } from "@/lib/finance/reconcile";

jest.mock("@/lib/email", () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = "reconcile-mirror-source-test";
// One mirror per integration worker DB, so parallel workers never share it.
const MIRROR_DB = `${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_mirror`;
const MIGRATIONS = path.resolve(__dirname, "../../../../../packages/s-ingest-core/prisma/migrations");

let mirror: Client;
let restoreBoardSettings: () => Promise<void> = async () => {};
let nextOrder = 1;

function urlFor(db: string): string {
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${db}`;
    return url.toString();
}

async function withAdmin(sql: string): Promise<void> {
    const admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
        await admin.query(sql);
    } finally {
        await admin.end();
    }
}

type Source = "BACKFILL" | "INCREMENTAL" | "HAND_LOADED" | "TEST_LOADED" | null;

/** One paid mirror order carrying checkout cart attributes, written as `source`. */
async function mirrorOrder(opts: {
    source: Source;
    attrs: Record<string, string>;
    financialStatus?: string;
    totalRefundedCents?: number;
    variantId?: string;
}): Promise<string> {
    const legacyId = `${TAG}-${nextOrder++}`;
    const gid = `gid://shopify/Order/${legacyId}`;
    const noteAttributes = Object.entries(opts.attrs).map(([key, value]) => ({ key, value }));
    await mirror.query(
        `INSERT INTO shop_order (shopify_gid, store_id, legacy_id, financial_status, total_cents, subtotal_cents,
                                 total_refunded_cents, updated_at, note_attributes, source)
         VALUES ($1, 's', $2, $3, 5000, 5000, $4, now() AT TIME ZONE 'UTC', $5, $6::"EventSource")`,
        [gid, legacyId, opts.financialStatus ?? "PAID", opts.totalRefundedCents ?? 0, JSON.stringify(noteAttributes), opts.source],
    );
    if (opts.variantId) {
        await mirror.query(
            `INSERT INTO shop_order_line (line_gid, order_gid, store_id, quantity, variant_legacy_id)
             VALUES ($1, $2, 's', 1, $3)`,
            [`${gid}/line`, gid, opts.variantId],
        );
    }
    return legacyId;
}

/** A household lead with an OrgMembership and one process at `status`. */
async function applicant(email: string, status: "PENDING_PAYMENT" | "ACTIVE", shopifyOrderId?: string) {
    const hh = await prisma.household.create({ data: { name: `HH ${TAG} ${email}` } });
    await prisma.person.create({ data: { email, name: `Lead ${email}`, isHouseholdLead: true, householdId: hh.id } });
    const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: status === "ACTIVE" ? "ACTIVE" : "NONE" } });
    const proc = await prisma.orgMembershipProcess.create({
        data: {
            orgMembershipId: m.id,
            kind: "INITIAL",
            status,
            bgClearedAt: new Date(),
            shopifyOrderId: shopifyOrderId ?? null,
            paidAt: status === "ACTIVE" ? new Date() : null,
        },
    });
    return proc.id;
}

/** A household lead enrolled PENDING in a program sold as `variant-<email>`. */
async function enrollment(email: string) {
    const hh = await prisma.household.create({ data: { name: `HH ${TAG} ${email}` } });
    const person = await prisma.person.create({ data: { email, name: `Lead ${email}`, isHouseholdLead: true, householdId: hh.id } });
    const variantId = `variant-${email}`;
    const program = await prisma.program.create({
        data: { name: `Program ${TAG} ${email}`, startAt: new Date("2026-06-01"), endAt: new Date("2026-08-01"), shopifyVariantId: variantId },
    });
    await prisma.programParticipant.create({ data: { programId: program.id, personId: person.id, status: "PENDING" } });
    return { programId: program.id, personId: person.id, variantId };
}

const processStatus = async (id: number) => (await prisma.orgMembershipProcess.findUnique({ where: { id } }))?.status;
const enrollmentStatus = async (programId: number, personId: number) =>
    (await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId } } }))?.status;
const exceptionsFor = (shopifyOrderId: string) => prisma.paymentException.count({ where: { shopifyOrderId } });

beforeAll(async () => {
    await withAdmin(`DROP DATABASE IF EXISTS "${MIRROR_DB}" WITH (FORCE)`);
    await withAdmin(`CREATE DATABASE "${MIRROR_DB}"`);
    mirror = new Client({ connectionString: urlFor(MIRROR_DB) });
    await mirror.connect();
    for (const dir of fs.readdirSync(MIGRATIONS).filter((d) => /^\d+_/.test(d)).sort()) {
        await mirror.query(fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8"));
    }
    process.env.SHOPIFY_READ_DATABASE_URL = urlFor(MIRROR_DB);

    restoreBoardSettings = await snapshotBoardSettings();
    const settings = { standardMembershipFeeCents: 5000, volunteerMembershipFeeCents: 2000, orgMembershipYearBoundary: null, shopifyReconcileCursorAt: null };
    await prisma.boardSettings.upsert({ where: { id: 1 }, create: { id: 1, ...settings }, update: settings });
}, 60_000);

afterAll(async () => {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    const programs = await prisma.program.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const programIds = programs.map((p) => p.id);
    await prisma.paymentException.deleteMany({ where: { shopifyOrderId: { startsWith: `${TAG}-` } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.programParticipant.deleteMany({ where: { programId: { in: programIds } } });
    await prisma.program.deleteMany({ where: { id: { in: programIds } } });
    await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
    await restoreBoardSettings();

    await mirror?.end();
    delete process.env.SHOPIFY_READ_DATABASE_URL;
    await withAdmin(`DROP DATABASE IF EXISTS "${MIRROR_DB}" WITH (FORCE)`);
}, 60_000);

describe("reconcile reads only API-synced mirror rows", () => {
    it("forward pass: hand/test-loaded orders activate nothing; API and NULL-source orders still activate", async () => {
        const handProc = await applicant(`hand-${TAG}@ex.com`, "PENDING_PAYMENT");
        const testProc = await applicant(`testload-${TAG}@ex.com`, "PENDING_PAYMENT");
        const backfillProc = await applicant(`backfill-${TAG}@ex.com`, "PENDING_PAYMENT");
        const nullProc = await applicant(`null-${TAG}@ex.com`, "PENDING_PAYMENT");
        const handPrg = await enrollment(`hand-prg-${TAG}@ex.com`);
        const apiPrg = await enrollment(`api-prg-${TAG}@ex.com`);

        const handOrder = await mirrorOrder({ source: "HAND_LOADED", attrs: { Membership_Process_ID: String(handProc) } });
        const testOrder = await mirrorOrder({ source: "TEST_LOADED", attrs: { Membership_Process_ID: String(testProc) } });
        await mirrorOrder({ source: "BACKFILL", attrs: { Membership_Process_ID: String(backfillProc) } });
        await mirrorOrder({ source: null, attrs: { Membership_Process_ID: String(nullProc) } });
        const handPrgOrder = await mirrorOrder({
            source: "HAND_LOADED",
            attrs: { Program_ID: String(handPrg.programId), CheckMeIn_Account_ID: String(handPrg.personId) },
            variantId: handPrg.variantId,
        });
        await mirrorOrder({
            source: "INCREMENTAL",
            attrs: { Program_ID: String(apiPrg.programId), CheckMeIn_Account_ID: String(apiPrg.personId) },
            variantId: apiPrg.variantId,
        });

        await runReconcile();

        expect(await processStatus(handProc)).toBe("PENDING_PAYMENT");
        expect(await processStatus(testProc)).toBe("PENDING_PAYMENT");
        expect(await enrollmentStatus(handPrg.programId, handPrg.personId)).toBe("PENDING");
        for (const oid of [handOrder, testOrder, handPrgOrder]) expect(await exceptionsFor(oid)).toBe(0);

        expect(await processStatus(backfillProc)).toBe("ACTIVE");
        expect(await processStatus(nullProc)).toBe("ACTIVE");
        expect(await enrollmentStatus(apiPrg.programId, apiPrg.personId)).toBe("ACTIVE");
    }, 30_000);

    it("reversal pass: a refunded hand-loaded order raises nothing; a refunded API order does", async () => {
        const handOrder = await mirrorOrder({ source: "HAND_LOADED", attrs: {}, financialStatus: "REFUNDED", totalRefundedCents: 5000 });
        const apiOrder = await mirrorOrder({ source: "INCREMENTAL", attrs: {}, financialStatus: "REFUNDED", totalRefundedCents: 5000 });
        await applicant(`hand-rev-${TAG}@ex.com`, "ACTIVE", handOrder);
        await applicant(`api-rev-${TAG}@ex.com`, "ACTIVE", apiOrder);

        await runReconcile();

        expect(await exceptionsFor(handOrder)).toBe(0);
        expect(await exceptionsFor(apiOrder)).toBe(1);
    }, 30_000);
});
