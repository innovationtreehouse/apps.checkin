import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { config } from "@/lib/config";
import { recentSentEmails, clearSentEmails } from "@/lib/dev/sentMail";

// Dev-only "Sent Mail" inbox (EMAIL_DEV_MOCK.md). When there is no RESEND_API_KEY, sendEmail
// captures what it would have sent; this page renders it so link/token flows can be completed
// without a real key. Access: on cloud-dev (CHECKIN_ENV=dev) the middleware already gates every
// page to verified org members; on local it's open (as intended). This page + its clear action
// additionally 404 anywhere that isn't a dev instance, so it's dead in prod by construction.
export const dynamic = "force-dynamic";

export const metadata = {
    title: "Dev — Sent Mail",
};

function devOnlyOrNotFound() {
    if (!config.devToolsActive()) notFound();
}

async function clearAction() {
    "use server";
    // Re-guard: a server action is an independently-callable POST endpoint, not covered by the
    // page render's guard.
    if (!config.devToolsActive()) return;
    await clearSentEmails();
    revalidatePath("/dev/sent-mail");
}

export default async function DevSentMailPage() {
    devOnlyOrNotFound();

    const emails = await recentSentEmails();

    return (
        <div style={{ maxWidth: 900 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "1rem" }}>
                <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>
                    Sent Mail <span style={{ fontWeight: 400, opacity: 0.6 }}>({emails.length})</span>
                </h1>
                <form action={clearAction}>
                    <button type="submit" style={{ padding: "0.4rem 0.9rem", cursor: "pointer" }}>
                        Clear
                    </button>
                </form>
            </div>
            <p style={{ opacity: 0.7, fontSize: "0.85rem", marginTop: "0.5rem" }}>
                Emails captured because no <code>RESEND_API_KEY</code> is set. Links resolve against this
                instance. Newest first.
            </p>

            {emails.length === 0 ? (
                <p style={{ marginTop: "2rem", opacity: 0.6 }}>No emails captured yet.</p>
            ) : (
                <ul style={{ listStyle: "none", padding: 0, marginTop: "1.5rem" }}>
                    {emails.map((email) => (
                        <li
                            key={email.id}
                            style={{ border: "1px solid rgba(0,0,0,0.15)", borderRadius: 8, padding: "1rem", marginBottom: "1rem" }}
                        >
                            <div style={{ fontSize: "0.8rem", opacity: 0.7, display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                                <span>To: <strong>{email.to}</strong></span>
                                <span>From: {email.from}</span>
                                <span>{new Date(email.createdAt).toLocaleString()}</span>
                            </div>
                            <div style={{ fontWeight: 600, margin: "0.4rem 0 0.75rem" }}>{email.subject}</div>
                            <iframe
                                style={{ width: "100%", minHeight: "400px", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 6, padding: "0.75rem", background: "#fff", color: "#111" }}
                                // Dev-only rendering of our own captured template HTML so embedded links/tokens
                                // are clickable. Never runs in prod (page 404s); content is what we ourselves sent.
                                srcDoc={email.html}
                                sandbox="allow-popups allow-popups-to-escape-sandbox"
                                title={`Email to ${email.to}`}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
