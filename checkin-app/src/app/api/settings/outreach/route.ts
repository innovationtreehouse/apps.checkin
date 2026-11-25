import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/api-response";
import { REGISTRY } from "@/lib/email-templates/registry";
import { findUnknownTokens } from "@/lib/email-templates/tokens";
import { readTemplateFields, writeTemplateFields, type FieldTargets } from "@/lib/email-templates/settingsFields";
import { upcomingBoundary } from "@/lib/membership/renewal";
import { orgToday } from "@/lib/appSettings";
import type { BusinessRole } from "@/types/auth";
import { personActor, recordAudit } from "@/lib/auditActor";

export const dynamic = "force-dynamic";

const ROLES: BusinessRole[] = ["isBoardMember", "isSysadmin", "isOperations"];
/** The Email Templates tab's roles: only they change email wording. */
const EDIT_ROLES: BusinessRole[] = ["isBoardMember", "isSysadmin"];

const SELECT = {
    outreachOpeningSubject: true,
    outreachOpeningBody: true,
    outreachReminderSubject: true,
    outreachReminderBody: true,
} as const;

type Field = keyof typeof SELECT;
const FIELDS = Object.keys(SELECT) as Field[];

const TARGETS: FieldTargets<Field> = {
    outreachOpeningSubject: [{ key: "outreach.opening", part: "subject" }],
    outreachOpeningBody: [{ key: "outreach.opening", part: "body" }],
    outreachReminderSubject: [{ key: "outreach.reminder", part: "subject" }],
    outreachReminderBody: [{ key: "outreach.reminder", part: "body" }],
};
const TOKENS = REGISTRY["outreach.opening"].allowedTokens;

/**
 * GET /api/settings/outreach — the saved outreach copy (null where a campaign sends its
 * default), under the BoardSettings field names, plus the current
 * membership-year boundary's next occurrence (read-only, for the live preview's
 * {{deadline}} — computed server-side so the client never has to re-derive upcomingBoundary()
 * and pull prisma into the bundle). Null when the boundary isn't configured yet.
 */
export const GET = withAuth({ roles: ROLES }, async () => {
    const settings = await readTemplateFields(TARGETS);
    const boundarySetting = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    const nextDeadline = boundarySetting?.orgMembershipYearBoundary
        ? upcomingBoundary(boundarySetting.orgMembershipYearBoundary, await orgToday()).toISOString().slice(0, 10)
        : null;
    return NextResponse.json({ settings, nextDeadline });
});

/**
 * PUT /api/settings/outreach — saves the outreach copy to its `EmailTemplate` rows and its
 * four BoardSettings columns. Deliberately separate from /api/settings/email (which drives
 * every outbound email's From/Reply-To): this route only ever writes outreach copy, and only
 * the Board and sysadmins may, as on the Email Templates tab. Validate-on-save: any `{{token}}`
 * outside {name, deadline, actionLink} rejects the WHOLE update (400), same shape as
 * settings/email's header validation.
 */
export const PUT = withAuth({ roles: EDIT_ROLES }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: Partial<Record<Field, string | null>>;
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }

    const data: Record<string, string | null> = {};
    for (const field of FIELDS) {
        if (body[field] === undefined) continue;
        const value = (body[field] ?? "").toString();
        const unknown = findUnknownTokens(value, TOKENS);
        if (unknown.length) {
            return apiError(`Unknown token {{${unknown[0]}}} in ${field} — only {{name}}, {{deadline}}, {{actionLink}} are allowed.`, 400);
        }
        data[field] = value.trim() ? value : null;
    }

    await prisma.$transaction(async (tx) => {
        await tx.boardSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data, select: SELECT });
        await writeTemplateFields(tx, TARGETS, data, auth.user.id);
        await recordAudit(tx, personActor(auth.user.id), { action: "EDIT", tableName: "BoardSettings", affectedEntityId: 1, newData: data });
    });

    return NextResponse.json({ settings: await readTemplateFields(TARGETS) });
});
