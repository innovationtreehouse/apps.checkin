import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { config } from "@/lib/config";
import { refreshQuickBooksLists } from "@/lib/finance/quickBooksLists";
import { listQuickBooksClasses } from "@/lib/finance/budgetOwners";
import { listQuickBooksAccounts } from "@/lib/finance/booksMap";
import { getAccessToken } from "@/lib/shopify/client";
import { getProductByHandle, type AdminProduct } from "@/lib/shopify/products";
import { variantSlotYears } from "@/lib/programYear";
import { BOOKS_MAP_ROLES, BOOKS_MAP_ROLE_ACCOUNT_TYPES } from "@checkin/quickbooks";
import { DEV_SEED_MEMBERSHIP_HANDLE, DEV_SEED_ROLE_ACCOUNTS, devSeedProgramHandle } from "@/lib/dev/linkNames";

/** A link failure whose message names what to fix; the reset shows it to the tester. */
export class DevLinkError extends Error {}

export const RUN_SETUP_SCRIPTS = "Run the dev sandbox and dev-store setup scripts to create what is missing, then reset again.";

type Write = (tx: Prisma.TransactionClient) => Promise<unknown>;

/**
 * After the reseed, finds the QuickBooks Classes and accounts and the Shopify products and variants
 * the seeded rows name, and writes their ids. Reads the services only; anything missing fails the
 * step, naming each object, before any id is written. On local it reads the stand-in lists and
 * leaves Shopify to the mock.
 */
export async function linkDevExternalIds(): Promise<string> {
    const env = config.checkinEnv();
    if (env !== "dev" && env !== "local") throw new Error("The dev link step runs only on dev and local.");

    const missing: string[] = [];
    const writes: Write[] = [];

    if (env === "dev" && !(await refreshQuickBooksLists())) {
        throw new DevLinkError("QuickBooks is not connected on this instance, so the reset cannot link the sandbox's Classes and accounts.");
    }
    const classes = (await listQuickBooksClasses()).filter((c) => c.active);
    const buckets = await prisma.budgetOwner.findMany({ where: { archivedAt: null }, select: { id: true, name: true } });
    for (const bucket of buckets) {
        const klass = classes.find((c) => c.name === bucket.name);
        if (!klass) missing.push(`QuickBooks Class "${bucket.name}"`);
        else writes.push((tx) => tx.budgetOwner.update({ where: { id: bucket.id }, data: { quickBooksClassId: klass.id } }));
    }

    const accounts = (await listQuickBooksAccounts()).filter((a) => a.active);
    for (const role of BOOKS_MAP_ROLES) {
        const name = DEV_SEED_ROLE_ACCOUNTS[role];
        const types = BOOKS_MAP_ROLE_ACCOUNT_TYPES[role];
        const account = accounts.find((a) => a.name === name && types.includes(a.accountType));
        if (!account) {
            missing.push(`QuickBooks account "${name}" (${types.join(" or ")}) for ${role}`);
            continue;
        }
        const quickBooksAccountId = account.id;
        writes.push((tx) => tx.booksMapRoleAccount.upsert({ where: { role }, create: { role, quickBooksAccountId }, update: { quickBooksAccountId } }));
    }

    let shopify = "Shopify left to the local mock";
    if (env === "dev") {
        const linked = await findShopifyIds(missing, writes);
        shopify = `${linked.years} membership years, ${linked.programs} programs`;
    }

    if (missing.length > 0) throw new DevLinkError(`The reset could not find: ${missing.join("; ")}. ${RUN_SETUP_SCRIPTS}`);
    await prisma.$transaction(async (tx) => {
        for (const write of writes) await write(tx);
    });
    return `Linked ${buckets.length} Classes, ${BOOKS_MAP_ROLES.length} books-map accounts, ${shopify}`;
}

async function findShopifyIds(missing: string[], writes: Write[]): Promise<{ years: number; programs: number }> {
    const storeDomain = config.shopifyStoreDomain();
    const accessToken = storeDomain ? await getAccessToken() : null;
    if (!storeDomain || !accessToken) {
        throw new DevLinkError("Shopify is not configured on this instance, so the reset cannot link the dev store's products.");
    }
    const product = (handle: string): Promise<AdminProduct | null> => getProductByHandle(storeDomain, accessToken, handle);

    const settings = await prisma.boardSettings.findUniqueOrThrow({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    const years = settings.orgMembershipYearBoundary ? variantSlotYears(settings.orgMembershipYearBoundary, new Date()) : [];
    const membership = await product(DEV_SEED_MEMBERSHIP_HANDLE);
    if (!membership) missing.push(`Shopify product "${DEV_SEED_MEMBERSHIP_HANDLE}"`);
    for (const membershipYear of membership ? years : []) {
        const variantId = membership?.variants?.find((v) => v.title === String(membershipYear))?.id?.toString();
        if (!variantId) missing.push(`Shopify variant "${membershipYear}" on "${DEV_SEED_MEMBERSHIP_HANDLE}"`);
        else writes.push((tx) => tx.membershipYearVariant.upsert({ where: { membershipYear }, create: { membershipYear, shopifyVariantId: variantId }, update: { shopifyVariantId: variantId } }));
    }

    const programs = await prisma.program.findMany({ select: { id: true, name: true } });
    for (const program of programs) {
        const [pub, claimant] = await Promise.all((["public", "claimant"] as const).map(async (kind) => {
            const handle = devSeedProgramHandle(program.name, kind);
            const found = await product(handle);
            const productId = found?.id?.toString();
            const variantId = found?.variants?.[0]?.id?.toString();
            if (!productId || !variantId) missing.push(`Shopify product "${handle}" with a variant`);
            return productId && variantId ? { productId, variantId } : null;
        }));
        if (!pub || !claimant) continue;
        writes.push((tx) => tx.program.update({
            where: { id: program.id },
            data: { shopifyProductId: pub.productId, shopifyVariantId: pub.variantId, claimantShopifyProductId: claimant.productId, claimantShopifyVariantId: claimant.variantId },
        }));
    }
    return { years: years.length, programs: programs.length };
}
