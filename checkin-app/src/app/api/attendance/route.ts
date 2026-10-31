import { NextRequest, NextResponse } from "next/server";
import { getOptionalSessionUser } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getKioskPublicKeys, verifyKioskSignature } from "@/lib/verify-kiosk";
import { buildingLink } from "@/lib/kioskSeen";
import { getFullAttendance } from "@/lib/getFullAttendance";
import { logBackendError } from "@/lib/logger";
import { config } from "@/lib/config";
import { apiError } from "@/lib/api-response";

// GET is kiosk-first with distinct signature-failure semantics (403 on bad signature,
// not 401), so it has its own kiosk plumbing instead of withAuth. The denied-household
// gate is applied inline below.
export async function GET(req: NextRequest) {
    try {
        // Determine caller identity. getOptionalSessionUser applies the shared
        // denied-household gate (a denied member resolves to undefined), so even
        // on this kiosk-tolerant route a denied member can't read counts/safety.
        const user = await getOptionalSessionUser(req);

        // Staging access gate: must run BEFORE the kiosk
        // branch below. This route re-verifies kiosk auth directly via
        // verifyKioskSignature rather than through authenticateRequest — the one
        // place that happens outside the chokepoint — so without this early
        // return, a caller carrying a VALID kiosk signature would still set
        // isKiosk=true, reach isAdmin, and get the full roster + safety data even
        // after the gate rejected them. See
        // tests/security/routeAuthDrift.test.ts rule 4.
        if (config.isStaging() && !user) {
            return apiError("Unauthorized", 401);
        }

        const hasKioskHeaders = req.headers.get("x-kiosk-signature");
        const pubKeys = getKioskPublicKeys();

        let isKiosk = false;

        // Minimization keys on the DISPLAY, not the credential (see
        // docs/rules/attendance-checkin.md, "The kiosk" — public-screen only).
        // A valid kiosk signature means this request is the public
        // kiosk screen — even when a keyholder has signed in on that same
        // browser. The staff grant (`keyholders:personal`) stays on a session
        // request that is NOT kiosk-signed (a laptop, not the door display).
        if (pubKeys.length > 0 && hasKioskHeaders) {
            const result = verifyKioskSignature(
                "GET",
                "/api/attendance",
                "",
                req.headers.get("x-kiosk-timestamp"),
                req.headers.get("x-kiosk-signature"),
                req.headers.get("x-kiosk-nonce"),
                pubKeys
            );
            if (!result.ok) {
                return apiError(result.error, result.status);
            }
            isKiosk = true;
        } else if (!user && pubKeys.length > 0) {
            // No session and no kiosk headers — reject
            return apiError("Unauthorized", 401);
        } else if (!user && pubKeys.length === 0 && config.isLocal()) {
            // Local dev only (CHECKIN_ENV=local): no pubKey configured, treat as kiosk.
            // Deliberately gated on isLocal() — on the cloud dev instance or prod an
            // unset KIOSK_PUBLIC_KEY must NOT grant full attendance/safety access to
            // anonymous callers. Mirrors the keyless-kiosk gating in src/lib/auth.ts.
            isKiosk = true;
        } else if (!user) {
            return apiError("Unauthorized", 401);
        }

        // The kiosk is an unattended device in a public room and re-broadcasts this
        // payload into an iframe with a wildcard postMessage target origin
        // (client/client.py). It gets a display-only roster: no dateOfBirth
        // (personal), no phone (pii), no emergency contacts (personal) — none of
        // which it renders. A signed-in keyholder on a non-kiosk browser still
        // gets the full payload (pickup/emergency lookups).
        const { attendance, counts, safety } = await getFullAttendance({ kiosk: isKiosk });
        // Web surfaces state occupancy/open/supervision as fact only while the
        // kiosk is reachable (docs/rules/attendance-checkin.md).
        const building = buildingLink();

        // Determine access level
        const isAdmin = isKiosk || user?.isSysadmin || user?.isBoardMember || user?.isKeyholder;

        if (isAdmin) {
            // ⚠ corner count for the door display: parked scans awaiting
            // a human. An aggregate only — names and reasons stay on the panel.
            const needReview = await prisma.rawBadgeLog.count({
                where: { reviewReason: { not: null }, reviewedAt: null },
            });
            // Full roster access: all visits + counts (kiosk gets the reduced rows above)
            return NextResponse.json({
                access: "full",
                attendance,
                counts: { ...counts, needReview },
                safety,
                building,
                signedRequest: isKiosk,
            });
        }

        // Limited access: counts + household members + self only
        const selfVisit = user ? attendance.find(v => v.participant.id === Number(user.id)) || null : null;
        const householdVisits = (user?.householdId)
            ? attendance.filter(v => v.participant.householdId === user.householdId)
            : [];

        return NextResponse.json({
            access: "limited",
            counts,
            safety,
            self: selfVisit,
            household: householdVisits,
            building,
            signedRequest: isKiosk,
        });
    } catch (error) {
        await logBackendError(error, "GET /api/attendance");
        return apiError("Internal Server Error while fetching attendance.", 500);
    }
}
