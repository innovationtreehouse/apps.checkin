import prisma from "./prisma";
import { config } from "./config";
import { parseEmailHeaderList } from "./emailHeader";

export interface EmailSenderIdentity {
    /**
     * The Resend `from`. BoardSettings.emailFromAddress wins over the EMAIL_FROM env
     * value; null when neither is configured, which sendEmail treats as "cannot send".
     */
    from: string | null;
    /** The Resend `replyTo` addresses (one or more), or undefined when the board hasn't configured any. */
    replyTo?: string[];
}

/**
 * Resolve the effective sender identity for outbound mail: the board can override
 * the EMAIL_FROM env value and add a Reply-To via Settings → Email. Falls back to
 * the env-only identity on any DB error so a settings-table hiccup never blocks
 * mail delivery. A null `from` means no sender is configured at either layer.
 *
 * ponytail: one findUnique on the single-row BoardSettings PK per send. Fan-outs
 * (e.g. notifyNewProgramAnnounced) pay it per recipient; the lookup is a cached
 * PK hit and those volumes are small. If a large fan-out ever dominates, resolve
 * once and pass the identity down.
 */
export async function getEmailSenderIdentity(): Promise<EmailSenderIdentity> {
    const envFrom = config.emailFrom();
    try {
        const settings = await prisma.boardSettings.findUnique({
            where: { id: 1 },
            select: { emailFromAddress: true, emailReplyToAddress: true },
        });
        const replyToRaw = settings?.emailReplyToAddress?.trim();
        return {
            from: settings?.emailFromAddress?.trim() || envFrom,
            replyTo: (replyToRaw ? parseEmailHeaderList(replyToRaw) : null) ?? undefined,
        };
    } catch {
        return { from: envFrom };
    }
}
