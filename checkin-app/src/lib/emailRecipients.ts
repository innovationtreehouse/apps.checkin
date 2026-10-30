import prisma from "@/lib/prisma";
import { sendEmail, runPaced } from "@/lib/email";
import { sendTemplated } from "@/lib/email-templates/send";
import type { TemplateCtx, TemplateKey } from "@/lib/email-templates/registry";
import { logger } from "@/lib/logger";
import { LIVE_PERSON } from "@/lib/person/filters";

/**
 * Email fan-out helpers. Kept dependency-light (prisma + email + templates + logger only) so
 * any path can resolve-and-send without an import cycle. Callers name a template,
 * fill its tokens and pass a distinct errorLabel; these helpers only resolve
 * recipients and swallow send/query errors.
 */

export interface HouseholdRecipient { email: string; settings: Record<string, unknown> | null; }

/**
 * Household leads (∪ one extra person, e.g. a participant/requester), deduped by
 * lowercased email, each carrying its own notificationSettings for per-recipient gating.
 * A child participant with no email simply drops out (filtered) and is covered by leads.
 */
export async function resolveHouseholdRecipients(
    householdId: number,
    alsoPersonId?: number | null,
): Promise<HouseholdRecipient[]> {
    try {
        const people = await prisma.person.findMany({
            where: {
                householdId,
                ...(alsoPersonId ? { OR: [{ isHouseholdLead: true }, { id: alsoPersonId }] } : { isHouseholdLead: true }),
                ...LIVE_PERSON,
            },
            select: { email: true, notificationSettings: true },
        });
        const seen = new Set<string>();
        const out: HouseholdRecipient[] = [];
        for (const p of people) {
            if (!p.email) continue;
            const key = p.email.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ email: p.email, settings: (p.notificationSettings as Record<string, unknown> | null) ?? null });
        }
        return out;
    } catch (e) {
        logger.error("resolveHouseholdRecipients failed:", e);
        return [];
    }
}

/**
 * Send one templated email to each recipient. sendTemplated never rejects
 * (failures resolve to `false` and are already persisted via logIntegrationError)
 * — this just fans out, nothing left to catch here.
 */
function fanOutEmails<K extends TemplateKey>(emails: string[], key: K, ctx: TemplateCtx<K>): Promise<boolean[]> {
    return runPaced(emails.map((email) => () => sendTemplated(key, email, ctx)));
}

/** Email every lead of a household. Resolve + fan-out; all errors logged and swallowed. */
export async function emailHouseholdLeads<K extends TemplateKey>(householdId: number, key: K, ctx: TemplateCtx<K>, errorLabel: string): Promise<void> {
    try {
        const leads = await prisma.person.findMany({
            where: { householdId, isHouseholdLead: true, ...LIVE_PERSON },
            select: { email: true },
        });
        const emails = leads.map((l) => l.email).filter((e): e is string => !!e);
        await fanOutEmails(emails, key, ctx);
    } catch (e) {
        logger.error(errorLabel, e);
    }
}

async function boardMemberEmails(): Promise<string[]> {
    const board = await prisma.person.findMany({
        where: { isBoardMember: true, email: { not: null }, ...LIVE_PERSON },
        select: { email: true },
    });
    return board.map((b) => b.email).filter((e): e is string => !!e);
}

/** Email every board member with an address on file. Resolve + fan-out; all errors logged and swallowed. */
export async function emailBoardMembers<K extends TemplateKey>(key: K, ctx: TemplateCtx<K>, errorLabel: string): Promise<void> {
    try {
        await fanOutEmails(await boardMemberEmails(), key, ctx);
    } catch (e) {
        logger.error(errorLabel, e);
    }
}

/** The scholarship review notice's board fallback, which builds its own HTML. */
export async function emailBoardMembersHtml(subject: string, html: string, errorLabel: string): Promise<void> {
    try {
        const emails = await boardMemberEmails();
        await runPaced(emails.map((email) => () => sendEmail(email, subject, html)));
    } catch (e) {
        logger.error(errorLabel, e);
    }
}

/**
 * Email every FINANCE holder with an address on file, or the board when no one
 * holds FINANCE, so a finance control flag always reaches a person. Resolve +
 * fan-out; all errors logged and swallowed.
 */
export async function notifyFinanceAlert<K extends TemplateKey>(key: K, ctx: TemplateCtx<K>, errorLabel: string): Promise<void> {
    try {
        const finance = await prisma.person.findMany({
            where: { roles: { some: { role: "FINANCE" } }, email: { not: null }, ...LIVE_PERSON },
            select: { email: true },
        });
        const emails = finance.map((f) => f.email).filter((e): e is string => !!e);
        if (emails.length === 0) return emailBoardMembers(key, ctx, errorLabel);
        await fanOutEmails(emails, key, ctx);
    } catch (e) {
        logger.error(errorLabel, e);
    }
}
