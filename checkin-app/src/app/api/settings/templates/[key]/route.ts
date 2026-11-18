import prisma from "@/lib/prisma";
import { handler, unauthorized } from "@/security/handler";
import { readDraft } from "./draft";

export const dynamic = "force-dynamic";

/**
 * PUT /api/settings/templates/[key] — save the Board's subject/body for one key.
 * A blank field sends its registry default; saving both blank removes the row
 * and answers null.
 */
export const PUT = handler<{ key: string }>("PUT /api/settings/templates/[key]", async ({ req, auth, params }) => {
    if (auth.type !== "session") throw unauthorized();
    const { key, subject, body } = await readDraft(req, params.key);
    if (!subject.trim() && !body.trim()) {
        await prisma.emailTemplate.deleteMany({ where: { key } });
        return { EmailTemplate: null };
    }
    const data = { subject, body, updatedBy: auth.user.id };
    const row = await prisma.emailTemplate.upsert({ where: { key }, create: { key, ...data }, update: data });
    return { EmailTemplate: row };
});
