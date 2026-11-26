import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { nextBoundary } from "@/lib/membership/renewal";
import { membershipYearStart } from "@/lib/programYear";
import { orgToday } from "@/lib/appSettings";
import { isNotRenewingRenewal } from "@/lib/membership/notRenewing";
import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * Drives the login-time renewal banner. Returns whether the caller is a household
 * lead whose household has an open renewal awaiting confirmation, plus the due date
 * (the boundary that opens the renewal's year), whether that date is already past, and whether the household has said it won't renew into that renewal's year.
 * Renewal is lead-driven, so only leads see the nudge.
 */
export const GET = withAuth({}, async (_req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);

    const user = await prisma.person.findUnique({
        where: { id: auth.user.id },
        select: { householdId: true, isHouseholdLead: true },
    });
    if (!user?.householdId) return NextResponse.json({ renewalDue: false });

    if (!user.isHouseholdLead) return NextResponse.json({ renewalDue: false });

    const open = await prisma.orgMembershipProcess.findFirst({
        where: { kind: "RENEWAL", status: "PENDING_RENEWAL", orgMembership: { householdId: user.householdId } },
        select: { kind: true, membershipYear: true, createdAt: true, orgMembership: { select: { notRenewingYear: true } } },
    });
    if (!open) return NextResponse.json({ renewalDue: false });

    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    const boundary = settings?.orgMembershipYearBoundary;
    const due = !boundary ? null
        : open.membershipYear != null ? membershipYearStart(boundary, open.membershipYear)
        : nextBoundary(boundary, open.createdAt);
    const wasDue = due ? due.getTime() < (await orgToday()).getTime() : false;
    const notRenewing = isNotRenewingRenewal(open, open.orgMembership?.notRenewingYear ?? null, boundary);

    return NextResponse.json({ renewalDue: true, dueDate: due ? due.toISOString().slice(0, 10) : null, wasDue, notRenewing });
});
