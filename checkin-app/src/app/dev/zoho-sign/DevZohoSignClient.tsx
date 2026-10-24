"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Dev Zoho Sign mock UI. Two modes, both dev-only (the page 404s off a dev instance):
 *
 *  - With a request id (?rid, how the mock's getEmbeddedSignUrl redirects here): the
 *    signing interstitial. "Complete signing (DEV)" fires the real webhook via the dev
 *    endpoint then lands on ?signed=1 (same as returning from real Zoho); "Decline (DEV)"
 *    navigates to ?declined=1, mirroring Zoho's sign_declined redirect.
 *  - Without a rid (reached from the "Debug: Sign" nav item): a start/resume entry that
 *    POSTs the REAL sign action; in mock mode that hands back this same interstitial URL
 *    (now carrying a rid), so the nav entry drops you into the flow without re-clicking
 *    Sign on the membership page.
 *
 * Inline styles match the sibling dev tool (dev/sent-mail, EMAIL_DEV_MOCK.md).
 */
export default function DevZohoSignClient({ rid }: { rid: string | null }) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function complete() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch("/api/dev/zoho-sign/complete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ rid }),
            });
            if (!res.ok) {
                setError(`Completion failed (${res.status}). Check server logs.`);
                setBusy(false);
                return;
            }
            router.push("/membership?signed=1");
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    }

    async function startSigning() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch("/api/membership/contract/sign", { method: "POST" });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.url) {
                window.location.href = data.url;
                return;
            }
            setError(data.error ? `${data.error} (${res.status})` : `Could not start signing (${res.status}).`);
            setBusy(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    }

    const btn = (bg: string): React.CSSProperties => ({
        padding: "0.5rem 1rem",
        borderRadius: 6,
        border: "none",
        background: bg,
        color: "#fff",
        fontWeight: 600,
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.5 : 1,
    });

    return (
        <div style={{ maxWidth: 640 }}>
            <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>Zoho Sign (mock)</h1>
            <p style={{ opacity: 0.7, fontSize: "0.85rem", marginTop: "0.5rem" }}>
                Zoho Sign is mocked on this instance (no OAuth secrets). This stands in for the
                embedded signing ceremony — <strong>DEV, NOT A LEGAL AGREEMENT</strong>.
            </p>

            {error && <p style={{ color: "#b91c1c", marginTop: "1rem" }}>{error}</p>}

            {rid ? (
                <div style={{ marginTop: "1.5rem" }}>
                    <p style={{ fontSize: "0.85rem", opacity: 0.7 }}>
                        Request <code>{rid}</code>
                    </p>
                    <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.75rem" }}>
                        <button onClick={complete} disabled={busy} style={btn("#059669")}>
                            {busy ? "Completing…" : "Complete signing (DEV)"}
                        </button>
                        <button
                            onClick={() => {
                                router.push("/membership?declined=1");
                            }}
                            disabled={busy}
                            style={{ ...btn("transparent"), color: "#374151", border: "1px solid #d1d5db" }}
                        >
                            Decline (DEV)
                        </button>
                    </div>
                </div>
            ) : (
                <div style={{ marginTop: "1.5rem" }}>
                    <p style={{ fontSize: "0.9rem" }}>
                        No signing request in the URL. Start or resume signing for your in-flight
                        membership application:
                    </p>
                    <button onClick={startSigning} disabled={busy} style={{ ...btn("#2563eb"), marginTop: "0.75rem" }}>
                        {busy ? "Starting…" : "Start / resume signing"}
                    </button>
                </div>
            )}
        </div>
    );
}
