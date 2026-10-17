import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { APP_TIMEZONE } from "@/lib/time";
import { APP_LOCALE } from "@/lib/appSettings";
import { apiError } from "@/lib/api-response";
import { handler } from "@/security/handler";

export const dynamic = "force-dynamic";

const DEFAULTS = { id: 1, timezone: APP_TIMEZONE, locale: APP_LOCALE };

/** GET /api/admin/settings/localization — app-wide localization singleton (created on first read).
 *  Registry-governed: admission anyRole [isSysadmin]; envelope 'settings'.
 *  AppSettings is wholly public-tier; the gate is about admin surfaces. */
export const GET = handler('GET /api/admin/settings/localization', async () => {
    const settings = await prisma.appSettings.upsert({ where: { id: 1 }, create: DEFAULTS, update: {} });
    return { AppSettings: settings };
});

/**
 * PUT /api/admin/settings/localization — update localization settings.
 * Body may include: timezone (IANA), locale (BCP-47). Each is validated against the
 * runtime's Intl tables; an invalid value rejects the whole update (400) so the
 * previous value survives rather than being overwritten with garbage.
 */
export const PUT = withAuth({ roles: ["isSysadmin"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: { timezone?: string; locale?: string };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }

    const data: Record<string, string> = {};
    if (body.timezone !== undefined) {
        const tz = body.timezone.trim();
        if (!Intl.supportedValuesOf("timeZone").includes(tz)) {
            return apiError("timezone must be a valid IANA timezone", 400);
        }
        data.timezone = tz;
    }
    if (body.locale !== undefined) {
        const loc = body.locale.trim();
        try {
            if (Intl.getCanonicalLocales(loc)[0] !== loc) throw new Error();
        } catch {
            return apiError("locale must be a valid BCP-47 locale", 400);
        }
        data.locale = loc;
    }

    const settings = await prisma.appSettings.upsert({
        where: { id: 1 },
        create: { ...DEFAULTS, ...data },
        update: data,
    });

    await prisma.auditLog.create({
        data: {
            actorId: auth.user.id,
            action: "EDIT",
            tableName: "AppSettings",
            affectedEntityId: 1,
            newData: data,
        },
    });

    return NextResponse.json({ settings });
});
