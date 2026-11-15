import prisma from "@/lib/prisma";
import { handler } from "@/security/handler";

export const dynamic = "force-dynamic";

/** GET /api/settings/templates — every saved subject/body override; a key with no row sends its registry default. */
export const GET = handler("GET /api/settings/templates", async () => {
    const rows = await prisma.emailTemplate.findMany({ orderBy: { key: "asc" } });
    return { EmailTemplate: rows };
});
