/**
 * @jest-environment node
 */
import { configureReceipt, mailQueueService, type ReceiptConfig } from "@checkin/receipt";
import prisma from "@/lib/prisma";
import { personActor } from "@/lib/auditActor";
import { SELF_GRANT_REFUSAL_TABLE } from "@/lib/membership/selfGrantGuard";
import { removeAliasesForSignInEmail } from "@/lib/person/mailAliases";
import { createInOwnHousehold } from "@/lib/person/ownHousehold";
import { configureRuntime } from "../configure";
import { MAIL_ALIAS_REFUSAL_TABLE, addMailAlias, approveMailAlias, removeMailAlias } from "../mailAliases";

jest.mock("@aws-sdk/client-lambda", () => ({ LambdaClient: jest.fn(), InvokeCommand: jest.fn() }));
jest.mock("@checkin/receipt", () => ({
    configureReceipt: jest.fn(),
    createAnthropicOcr: jest.fn(),
    createGmailReader: jest.fn(),
    fixtureOcr: {},
    mailQueueService: { assignedPassingItem: jest.fn() },
}));
jest.mock("@checkin/expense", () => ({ reimbursementStatus: {} }));
jest.mock("@checkin/workflow-mapping", () => ({ ingestReceipt: jest.fn() }));
jest.mock("@checkin/bulk-donation", () => ({ recordInKindDonor: jest.fn(), withdrawInKind: jest.fn() }));
jest.mock("@/lib/catalog/configure", () => ({ getOrg: jest.fn() }));

const TAG = "mailalias";
const passingItem = jest.mocked(mailQueueService.assignedPassingItem);

function resolver() {
    configureRuntime();
    const config = jest.mocked(configureReceipt).mock.calls.at(-1)?.[0] as ReceiptConfig;
    return config.people?.submitterByEmail as (address: string) => Promise<{ id: number } | null>;
}

async function signedIn(local: string, domain = "example.com") {
    const person = await createInOwnHousehold(prisma, { name: `${TAG} ${local}`, email: `${TAG}.${local}@${domain}`, isDeclaredAdult: true });
    await prisma.account.create({ data: { userId: person.id, type: "oauth", provider: "google", providerAccountId: `${TAG}-${person.id}` } });
    await prisma.personRole.create({ data: { personId: person.id, role: "FINANCE" } });
    return person;
}

describe("mail aliases", () => {
    let actor: Awaited<ReturnType<typeof signedIn>>;
    let pat: Awaited<ReturnType<typeof signedIn>>;
    let other: Awaited<ReturnType<typeof signedIn>>;
    const add = (address: string, personEmail = pat.email ?? "", actorId = actor.id) => addMailAlias(actorId, { personEmail, address });

    beforeEach(async () => {
        passingItem.mockReset();
        actor = await signedIn("actor");
        pat = await signedIn("pat", "gmail.com");
        other = await signedIn("other");
    });

    afterEach(async () => {
        const people = await prisma.person.findMany({ where: { name: { startsWith: TAG } }, select: { id: true, householdId: true } });
        const ids = people.map((p) => p.id);
        await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { tableName: "PersonMailAlias" }, { tableName: MAIL_ALIAS_REFUSAL_TABLE }] } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: people.map((p) => p.householdId) } } });
    });

    describe("adding", () => {
        it("lowercases and trims before insert, and records the actor with a CREATE audit row carrying no address", async () => {
            const alias = await add("  Work.Pat+R@Example.COM ");
            expect(alias.address).toBe("work.pat+r@example.com");
            const row = await prisma.personMailAlias.findUniqueOrThrow({ where: { id: alias.id } });
            expect(row).toMatchObject({ canonicalKey: "work.pat@example.com", addedById: actor.id, approvedAt: null });
            const audit = await prisma.auditLog.findFirstOrThrow({ where: { tableName: "PersonMailAlias", affectedEntityId: alias.id } });
            expect(audit).toMatchObject({ action: "CREATE", actorId: actor.id, secondaryAffectedEntity: pat.id });
            expect(JSON.stringify(audit.newData)).not.toContain("example.com");
        });

        it("refuses a differently cased duplicate of an existing alias", async () => {
            await add("dup@example.com");
            await expect(add("DUP@example.com")).rejects.toMatchObject({ status: 409 });
        });

        it("refuses an address on another person's sign-in or alias by canonical key, and audits it", async () => {
            await expect(add(`${TAG}.other+x@example.com`)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("sign-in") });
            await add("shared@example.com", other.email ?? "");
            await expect(add("shared+y@example.com")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("alias") });
            expect(await prisma.auditLog.count({ where: { tableName: MAIL_ALIAS_REFUSAL_TABLE, affectedEntityId: pat.id, action: "EDIT" } })).toBe(2);
        });

        it("allows the same person's dot and plus variants, and refuses their exact sign-in address", async () => {
            await expect(add(`${TAG}.p.at@gmail.com`)).resolves.toBeDefined();
            await expect(add(`${TAG}.pat+r@gmail.com`)).resolves.toBeDefined();
            await expect(add(pat.email ?? "")).rejects.toMatchObject({ status: 409 });
        });

        it("refuses the receipt mailbox's own address", async () => {
            process.env.RECEIPT_MAILBOX_ADDRESS = "receipts@example.com";
            await expect(add("Receipts+x@example.com")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("mailbox") });
            delete process.env.RECEIPT_MAILBOX_ADDRESS;
        });

        it("refuses the actor and their household, under the self-grant refusal table", async () => {
            await expect(add("mine@example.com", actor.email ?? "")).rejects.toMatchObject({ status: 403 });
            const spouse = await prisma.person.create({ data: { id: pat.id + 100_000, name: `${TAG} spouse`, email: `${TAG}.spouse@example.com`, householdId: actor.householdId } });
            await expect(add("spouse-alias@example.com", spouse.email ?? "")).rejects.toMatchObject({ status: 403 });
            expect(await prisma.auditLog.count({ where: { tableName: SELF_GRANT_REFUSAL_TABLE, actorId: actor.id, action: "EDIT" } })).toBe(2);
        });
    });

    describe("approving", () => {
        it("refuses without an assigned passing item, and writes a refusal row", async () => {
            const alias = await add("first@example.com");
            passingItem.mockResolvedValue(null);
            await expect(approveMailAlias(actor.id, alias.id)).rejects.toMatchObject({ status: 409 });
            expect(passingItem).toHaveBeenCalledWith("first@example.com", pat.id);
            expect((await prisma.personMailAlias.findUniqueOrThrow({ where: { id: alias.id } })).approvedAt).toBeNull();
            expect(await prisma.auditLog.count({ where: { tableName: MAIL_ALIAS_REFUSAL_TABLE, secondaryAffectedEntity: alias.id } })).toBe(1);
        });

        it("refuses the alias holder themself", async () => {
            const alias = await add("first@example.com");
            passingItem.mockResolvedValue({ id: 5 });
            await expect(approveMailAlias(pat.id, alias.id)).rejects.toMatchObject({ status: 403 });
        });

        it("approves with the item named in an EDIT audit row, and only then resolves", async () => {
            const alias = await add("first@example.com");
            const resolve = resolver();
            expect(await resolve("first@example.com")).toBeNull();
            passingItem.mockResolvedValue({ id: 5 });
            expect(await approveMailAlias(actor.id, alias.id)).toMatchObject({ approvedById: actor.id });
            const audit = await prisma.auditLog.findFirstOrThrow({ where: { tableName: "PersonMailAlias", affectedEntityId: alias.id, action: "EDIT" } });
            expect(audit.newData).toMatchObject({ mailItemId: 5 });
            expect(await resolve("first@example.com")).toMatchObject({ id: pat.id });
        });
    });

    describe("resolving", () => {
        const approved = async (address: string, personId: number) =>
            prisma.personMailAlias.create({ data: { personId, address, canonicalKey: address, addedById: actor.id, approvedAt: new Date(), approvedById: actor.id } });

        it("answers the same person for the sign-in address and an approved alias, so limits keyed on the id are shared", async () => {
            await approved("second@example.com", pat.id);
            const resolve = resolver();
            expect((await resolve("second@example.com"))?.id).toBe(pat.id);
            expect((await resolve(pat.email ?? ""))?.id).toBe(pat.id);
        });

        it("resolves to nobody when an address matches two people", async () => {
            await approved(other.email ?? "", pat.id);
            expect(await resolver()(other.email ?? "")).toBeNull();
        });

        it("stops resolving once the alias is removed, with a DELETE audit row", async () => {
            const alias = await approved("gone@example.com", pat.id);
            const resolve = resolver();
            expect(await resolve("gone@example.com")).not.toBeNull();
            await removeMailAlias(actor.id, alias.id);
            expect(await resolve("gone@example.com")).toBeNull();
            expect(await prisma.auditLog.count({ where: { tableName: "PersonMailAlias", affectedEntityId: alias.id, action: "DELETE" } })).toBe(1);
        });
    });

    describe("a sign-in email change", () => {
        it("removes every alias on the canonical key, with an audit row naming the cause", async () => {
            const mine = await add("taken@example.com");
            const variant = await add("taken+r@example.com");
            await prisma.$transaction((tx) => removeAliasesForSignInEmail(tx, "Taken@example.com", personActor(actor.id), "board_email_change"));
            expect(await prisma.personMailAlias.count({ where: { id: { in: [mine.id, variant.id] } } })).toBe(0);
            const audit = await prisma.auditLog.findFirstOrThrow({ where: { tableName: "PersonMailAlias", affectedEntityId: mine.id, action: "DELETE" } });
            expect(audit).toMatchObject({ secondaryAffectedEntity: pat.id, newData: { cause: "board_email_change" } });
        });

        it("serialises with an add on the same key: whichever commits second sees the other", async () => {
            const results = await Promise.allSettled([
                add("race@example.com"),
                prisma.$transaction(async (tx) => {
                    await removeAliasesForSignInEmail(tx, "race@example.com", personActor(actor.id), "board_email_change");
                    await tx.person.update({ where: { id: other.id }, data: { email: "race@example.com" } });
                }),
            ]);
            expect(results[1].status).toBe("fulfilled");
            expect(await prisma.personMailAlias.count({ where: { address: "race@example.com" } })).toBe(0);
        });
    });
});
