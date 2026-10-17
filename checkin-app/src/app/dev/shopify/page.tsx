import { notFound } from "next/navigation";
import prisma from "@/lib/prisma";
import { config } from "@/lib/config";
import DevShopifyClient from "./DevShopifyClient";
import { LIVE_PERSON } from "@/lib/person/filters";

export const dynamic = "force-dynamic";

/**
 * ENV GATE: LOCAL ONLY. Stand-in for a Shopify orders/paid webhook (see
 * docs/designs/SHOPIFY_DEV_STORE_WEBHOOK.md §6). Lists the membership processes
 * AND program enrollments currently awaiting payment and fires a
 * synthesized-but-real webhook for the chosen one. 404s on dev AND prod
 * (shopifyMockActive() is true iff CHECKIN_ENV=local) — dev/prod pay through
 * their real Shopify store.
 */
export default async function DevShopifyPage() {
    if (!config.shopifyMockActive()) notFound(); // local only; 404 on dev + prod

    const processes = await prisma.orgMembershipProcess.findMany({
        where: { status: "PENDING_PAYMENT" },
        orderBy: { id: "desc" },
        select: { id: true, orgMembership: { select: { household: { select: { name: true } }, isVolunteer: true } } },
    });

    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    // Mock synthesizes a membership variant (config), so the fire tool is always usable on local.
    const hasVariant = config.shopifyMockActive() || !!settings?.orgMembershipVariantId;

    const pendingParticipants = await prisma.programParticipant.findMany({
        where: { status: "PENDING", person: LIVE_PERSON },
        orderBy: [{ programId: "desc" }, { personId: "asc" }],
        select: {
            personId: true,
            person: { select: { name: true } },
            program: {
                select: { id: true, name: true, shopifyVariantId: true },
            },
        },
    });

    return (
        <DevShopifyClient
            hasVariant={hasVariant}
            processes={processes.map((p) => ({
                id: p.id,
                household: p.orgMembership?.household?.name ?? "(unnamed household)",
                isVolunteer: p.orgMembership?.isVolunteer ?? false,
            }))}
            enrollments={pendingParticipants.map((pp) => ({
                programId: pp.program.id,
                programName: pp.program.name,
                personId: pp.personId,
                personName: pp.person.name ?? `Person #${pp.personId}`,
                hasVariant: !!pp.program.shopifyVariantId,
            }))}
        />
    );
}
