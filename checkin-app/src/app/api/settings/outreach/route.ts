import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/api-response";
import { findUnknownTokens } from "@/lib/outreach/tokens";
import { nextBoundary } from "@/lib/membership/renewal";
import type { BusinessRole } from "@/types/auth";

export const dynamic = "force-dynamic";

const ROLES: BusinessRole[] = ["isBoardMember", "isSysadmin", "isOperations"];

const SELECT = {
    outreachOpeningSubject: true,
    outreachOpeningBody: true,
    outreachReminderSubject: true,
    outreachReminderBody: true,
} as const;

type Field = keyof typeof SELECT;
const FIELDS = Object.keys(SELECT) as Field[];

/**
 * GET /api/settings/outreach — the four outreach template columns, plus the current
 * membership-year boundary's next occurrence (read-only, for the live preview's
 * {{deadline}} — computed server-side so the client never has to re-derive nextBoundary()
 * and pull prisma into the bundle). Null when the boundary isn't configured yet.
 */
export const GET = withAuth({ roles: ROLES }, async () => {
    const settings = await prisma.boardSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {}, select: SELECT });
    const boundarySetting = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    const nextDeadline = boundarySetting?.orgMembershipYearBoundary
        ? nextBoundary(boundarySetting.orgMembershipYearBoundary, new Date()).toISOString().slice(0, 10)
        : null;
    return NextResponse.json({ settings, nextDeadline });
});

/**
 * PUT /api/settings/outreach — sets the four outreach template columns. Deliberately
 * separate from /api/settings/email (which drives every outbound email's From/Reply-To —
 * operations must never touch that): this route only ever writes these four columns and is
 * open to isOperations. Validate-on-save: any `{{token}}` outside {name, deadline,
 * actionWord, actionLink} rejects the WHOLE update (400), same shape as settings/email's
 * header validation.
 */
export const PUT = withAuth({ roles: ROLES }, async (req, auth) => {
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
        const unknown = findUnknownTokens(value);
        if (unknown.length) {
            return apiError(`Unknown token {{${unknown[0]}}} in ${field} — only {{name}}, {{deadline}}, {{actionWord}}, {{actionLink}} are allowed.`, 400);
        }
        data[field] = value.trim() ? value : null;
    }

    const settings = await prisma.boardSettings.upsert({
        where: { id: 1 },
        create: { id: 1, ...data },
        update: data,
        select: SELECT,
    });

    await prisma.auditLog.create({
        data: { actorId: auth.user.id, action: "EDIT", tableName: "BoardSettings", affectedEntityId: 1, newData: data },
    });

    return NextResponse.json({ settings });
});
