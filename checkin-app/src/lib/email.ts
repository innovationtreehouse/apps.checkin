import { Resend } from 'resend';
import { config } from './config';
import { captureSentEmail } from './dev/sentMail';
import { getEmailSenderIdentity } from './emailIdentity';
import { logIntegrationError } from './logger';

const resend = config.resendApiKey()
    ? new Resend(config.resendApiKey()!)
    : null;

/**
 * Recipient as stored in IntegrationErrorLog: first character and domain only
 * (`j***@example.org`). Enough to spot a bad domain on System Status without
 * keeping the address itself.
 */
export function maskRecipient(to: string): string {
    return to
        .split(',')
        .map((addr) => addr.trim())
        .map((addr) => {
            const at = addr.lastIndexOf('@');
            return at > 0 ? `${addr[0]}***${addr.slice(at)}` : '***';
        })
        .join(', ');
}

/** Stand-in shown on /dev/sent-mail when no sender is configured. */
const UNCONFIGURED_FROM = '(no From configured)';

/**
 * Send an email via Resend. Falls back to console.log if no API key is configured.
 *
 * The From (and optional Reply-To) come from getEmailSenderIdentity(): the board
 * can override the EMAIL_FROM env value and set a Reply-To in Settings → Email.
 */
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
    const { from, replyTo } = await getEmailSenderIdentity();

    // Nothing can be delivered without a key, and nothing may be sent without a
    // sender — an unverified From is rejected by Resend for every recipient.
    if (!resend || !from) {
        console.log(`[Email (${resend ? 'no From address' : 'no RESEND_API_KEY'})] To: ${to} | Subject: ${subject}`);
        // Dev/local: capture the email so link/token flows are retrievable at /dev/sent-mail,
        // and report success so gating callers follow the prod happy-path. devToolsActive
        // fails safe to prod, so a prod box that somehow lost its key still falls through
        // to `return false` (fail loud, not fake success).
        if (config.devToolsActive()) {
            return captureSentEmail(from ?? UNCONFIGURED_FROM, to, subject, html);
        }
        if (!from) {
            // A missing key is reported by the config-health check; a missing sender is
            // not, so put it on System Status > Link Status instead of dropping silently.
            await logIntegrationError(
                'email',
                'No From address configured — set EMAIL_FROM or the From address in Settings → Email.',
                { to: maskRecipient(to), subject },
            );
        }
        return false;
    }

    try {
        const { error } = await resend.emails.send({
            from,
            to,
            subject,
            html,
            ...(replyTo ? { replyTo } : {}),
        });

        if (error) {
            console.error(`[Email Error] Failed to send to ${to}:`, error);
            // System Status > Link Status tab (see logIntegrationError). Deliberately no
            // `html` in context — log-hygiene contract asserted in email.test.ts.
            await logIntegrationError('email', error.message, { to: maskRecipient(to), subject });
            return false;
        }

        console.log(`[Email Sent] To: ${to} | Subject: ${subject}`);
        return true;
    } catch (err) {
        console.error(`[Email Exception] Failed to send to ${to}:`, err);
        await logIntegrationError('email', err, { to: maskRecipient(to), subject });
        return false;
    }
}

/**
 * Run async tasks in chunks, pausing `gapMs` between chunks — a crude client-side
 * rate limiter for provider fan-out (#1154, chunks of 5 @ 1/s). Best-effort: assumes
 * each task already swallows its own errors (sendEmail resolves false, never rejects),
 * so nothing is caught here. Order of results matches order of tasks.
 */
export async function runPaced<T>(
    tasks: Array<() => Promise<T>>,
    chunkSize = 5,
    gapMs = 1000,
): Promise<T[]> {
    const results: T[] = [];
    for (let i = 0; i < tasks.length; i += chunkSize) {
        const chunk = tasks.slice(i, i + chunkSize);
        results.push(...await Promise.all(chunk.map((t) => t())));
        if (i + chunkSize < tasks.length) {
            await new Promise((r) => setTimeout(r, gapMs));
        }
    }
    return results;
}
