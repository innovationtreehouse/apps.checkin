import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/api-response";
import { config } from "@/lib/config";
import { handler } from "@/security/handler";
import { isLibraryKey, type LibraryKey } from "@/lib/libraryRelease";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { variantSlotYears } from "@/lib/programYear";

export const dynamic = "force-dynamic";

const DEFAULTS = { id: 1, standardMembershipFeeCents: 0, volunteerMembershipFeeCents: 0 };

/** GET /api/settings/membership — board settings singleton (created on first read).
 *  Registry-governed: admission anyRole sysadmin/board; envelope 'settings'.
 *  Full row plus the variant rows for the year in progress and the coming year
 *  (incl. internal-tier Shopify ids) — covered by the admin band. */
export const GET = handler('GET /api/settings/membership', async () => {
    const settings = await prisma.boardSettings.upsert({ where: { id: 1 }, create: DEFAULTS, update: {} });
    const boundary = settings.orgMembershipYearBoundary;
    const variants = boundary
        ? await prisma.membershipYearVariant.findMany({ where: { membershipYear: { in: variantSlotYears(boundary, new Date()) } } })
        : [];
    return { BoardSettings: settings, MembershipYearVariant: variants };
});

type YearVariantWrite = { membershipYear: number; shopifyVariantId: string; productUrl: string | null };

/** The rows a save may write: a numeric variant for a year the settings page shows, or an error message. */
function parseYearVariants(raw: unknown, boundary: Date | null | undefined): YearVariantWrite[] | string {
    if (!boundary) return "Set the membership-year boundary before entering a year's variant";
    if (!Array.isArray(raw)) return "membershipYearVariants must be a list";
    const years: number[] = variantSlotYears(boundary, new Date());
    const rows: YearVariantWrite[] = [];
    for (const entry of raw as ({ membershipYear?: unknown; shopifyVariantId?: unknown; productUrl?: unknown } | null)[]) {
        const { membershipYear, shopifyVariantId, productUrl } = entry ?? {};
        if (typeof membershipYear !== "number" || !years.includes(membershipYear)) return "membershipYear must be the year in progress or the coming year";
        const variantId = typeof shopifyVariantId === "string" ? shopifyVariantId.trim() : "";
        if (!/^\d+$/.test(variantId)) return "shopifyVariantId must be a numeric Shopify variant ID";
        rows.push({ membershipYear, shopifyVariantId: variantId, productUrl: typeof productUrl === "string" ? productUrl.trim() || null : null });
    }
    return rows;
}

/**
 * PUT /api/settings/membership — update board settings.
 * Body may include: standardMembershipFeeCents, volunteerMembershipFeeCents, orgMembershipYearBoundary (ISO|null),
 * orgMembershipVariantId (string|null),
 * orgMembershipProductUrl (string|null), volunteerFamilyDiscountCode (string|null),
 * perYearVariantClient (true — required; any other body is refused with nothing changed),
 * membershipYearVariants ([{ membershipYear, shopifyVariantId, productUrl }] — replaced by year; 409 when
 * another year already holds the variant, and nothing in the save is kept),
 * scholarshipDenialGraceDays (positive int|null — null disables the grace-period expiry cron),
 * releaseLibrary ({ library: LibraryKey, released: boolean } — board members only; the nav's UI-only
 * release gate, merged into the stored list in one statement so concurrent toggles don't clobber).
 * Membership fees must be finite and >= 0; an invalid value rejects the whole update (400) so the
 * previous value survives rather than silently collapsing to zero. (The Averity consent
 * link is an env var, not a board setting. Email sender identity lives in /api/settings/email.)
 *
 * A field this environment has no use for is NOT a user-validation failure: it is dropped, not
 * rejected, so it can't 400 the whole batch. Only genuinely malformed user values fail the save.
 */
export const PUT = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: {
        standardMembershipFeeCents?: number;
        volunteerMembershipFeeCents?: number;
        orgMembershipYearBoundary?: string | null;
        orgMembershipVariantId?: string | null;
        orgMembershipProductUrl?: string | null;
        volunteerFamilyDiscountCode?: string | null;
        bgRecheckMonths?: number;
        devSigningTarget?: string | null;
        scholarshipDenialGraceDays?: number | null;
        releasedLibraries?: unknown;
        releaseLibrary?: { library?: unknown; released?: unknown } | null;
        membershipYearVariants?: unknown;
        perYearVariantClient?: unknown;
    };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    // A page without this marker cannot read the GET response, so its form holds defaults, not the stored settings.
    if (body.perYearVariantClient !== true) return apiError("This page is out of date. Reload the page and try again.", 400);

    const data: Record<string, unknown> = {};
    const invalidFee = (v: number) => !Number.isFinite(v) || v < 0;
    if (body.standardMembershipFeeCents !== undefined) {
        if (invalidFee(body.standardMembershipFeeCents)) return apiError("standardMembershipFeeCents must be a number >= 0", 400);
        data.standardMembershipFeeCents = Math.round(body.standardMembershipFeeCents);
    }
    if (body.volunteerMembershipFeeCents !== undefined) {
        if (invalidFee(body.volunteerMembershipFeeCents)) return apiError("volunteerMembershipFeeCents must be a number >= 0", 400);
        data.volunteerMembershipFeeCents = Math.round(body.volunteerMembershipFeeCents);
    }
    if (body.orgMembershipYearBoundary !== undefined) {
        data.orgMembershipYearBoundary = body.orgMembershipYearBoundary ? new Date(body.orgMembershipYearBoundary) : null;
    }
    if (body.orgMembershipVariantId !== undefined) {
        const variantId = body.orgMembershipVariantId?.trim();
        if (variantId && !/^\d+$/.test(variantId)) return apiError("orgMembershipVariantId must be a numeric Shopify variant ID", 400);
        data.orgMembershipVariantId = variantId || null;
    }
    // Reference only — the checkout link is built from the variant ID, never this
    // URL, and /extract-variant re-validates it hard before any server-side fetch.
    if (body.orgMembershipProductUrl !== undefined) {
        data.orgMembershipProductUrl = body.orgMembershipProductUrl?.trim() || null;
    }
    if (body.volunteerFamilyDiscountCode !== undefined) {
        data.volunteerFamilyDiscountCode = body.volunteerFamilyDiscountCode?.trim() || null;
    }
    if (body.bgRecheckMonths !== undefined) data.bgRecheckMonths = Math.max(0, Math.round(body.bgRecheckMonths));
    // Dev-instance-only knob (signing target radio). Off-dev the whole form still
    // POSTs it, so we IGNORE it rather than 400 — writing it never happens, so prod's
    // DB can never hold a value, and the read side (signingMockActive) fuses regardless.
    // Only on dev do we validate + persist.
    if (body.devSigningTarget !== undefined && config.checkinEnv() === "dev") {
        if (body.devSigningTarget !== null && body.devSigningTarget !== "zoho" && body.devSigningTarget !== "debug") {
            return apiError("devSigningTarget must be 'zoho', 'debug', or null", 400);
        }
        data.devSigningTarget = body.devSigningTarget;
    }
    // scholarshipDenialGraceDays: null = feature off (never guess a default); otherwise a positive integer.
    if (body.scholarshipDenialGraceDays !== undefined) {
        if (body.scholarshipDenialGraceDays !== null) {
            if (!Number.isFinite(body.scholarshipDenialGraceDays) || !Number.isInteger(body.scholarshipDenialGraceDays) || body.scholarshipDenialGraceDays <= 0) {
                return apiError("scholarshipDenialGraceDays must be a positive whole number of days, or null", 400);
            }
        }
        data.scholarshipDenialGraceDays = body.scholarshipDenialGraceDays;
    }

    if (body.releasedLibraries !== undefined) {
        return apiError("releasedLibraries is not writable; send releaseLibrary { library, released }", 400);
    }
    let release: { library: LibraryKey; released: boolean } | null = null;
    if (body.releaseLibrary !== undefined) {
        if (!auth.user.isBoardMember) return apiError("Only board members can release libraries", 403);
        const { library, released } = body.releaseLibrary ?? {};
        if (!isLibraryKey(library) || typeof released !== "boolean") {
            return apiError("releaseLibrary must be { library: <library key>, released: boolean }", 400);
        }
        release = { library, released };
    }

    let yearVariants: YearVariantWrite[] = [];
    if (body.membershipYearVariants !== undefined) {
        const stored = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
        const parsed = parseYearVariants(body.membershipYearVariants, stored?.orgMembershipYearBoundary);
        if (typeof parsed === "string") return apiError(parsed, 400);
        yearVariants = parsed;
    }

    const save = prisma.$transaction(async (tx) => {
        await tx.boardSettings.upsert({
            where: { id: 1 },
            create: { ...DEFAULTS, ...data },
            update: data,
        });
        // Delete first so two slots can swap variants without colliding on the unique index.
        await tx.membershipYearVariant.deleteMany({ where: { membershipYear: { in: yearVariants.map((v) => v.membershipYear) } } });
        await tx.membershipYearVariant.createMany({ data: yearVariants });
        if (release) {
            await tx.$executeRaw`UPDATE "BoardSettings" SET "releasedLibraries" =
                CASE WHEN ${release.released} THEN array_append(array_remove("releasedLibraries", ${release.library}), ${release.library})
                ELSE array_remove("releasedLibraries", ${release.library}) END
                WHERE id = 1`;
        }
        await tx.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: "EDIT",
                tableName: "BoardSettings",
                affectedEntityId: 1,
                // data holds a Date (orgMembershipYearBoundary); clone to a JSON-safe object.
                newData: JSON.parse(JSON.stringify({
                    ...data,
                    ...(release ? { releaseLibrary: release } : {}),
                    ...(yearVariants.length ? { membershipYearVariants: yearVariants } : {}),
                })),
            },
        });
        return tx.boardSettings.findUniqueOrThrow({ where: { id: 1 } });
    });

    try {
        return NextResponse.json({ settings: await save });
    } catch (err) {
        if (isPrismaError(err, "P2002")) return apiError("Another membership year already holds that variant", 409);
        throw err;
    }
});
