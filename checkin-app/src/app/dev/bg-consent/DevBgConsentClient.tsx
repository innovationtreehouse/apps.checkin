"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Dev background-check consent mock UI (the page 404s off a dev instance). Stands in
 * for Averity's hosted consent page: "Consent (DEV)" records real consent via the dev
 * endpoint then lands back on /membership. Inline styles match the sibling dev tool
 * (dev/zoho-sign).
 */
export default function DevBgConsentClient() {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function consent() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch("/api/dev/bg-consent/complete", { method: "POST" });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                setError(data.error ? `${data.error} (${res.status})` : `Consent failed (${res.status}). Check server logs.`);
                setBusy(false);
                return;
            }
            router.push("/membership");
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    }

    const btn: React.CSSProperties = {
        padding: "0.5rem 1rem",
        borderRadius: 6,
        border: "none",
        background: "#059669",
        color: "#fff",
        fontWeight: 600,
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.5 : 1,
    };

    return (
        <div style={{ maxWidth: 640 }}>
            <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>Background check (mock)</h1>
            <p style={{ opacity: 0.7, fontSize: "0.85rem", marginTop: "0.5rem" }}>
                Averity is mocked on this instance (no consent URL). This stands in for the hosted
                consent page — <strong>DEV, NOT A REAL BACKGROUND CHECK</strong>. Confirming records
                your consent and sends the application to the board for sign-off.
            </p>

            {error && <p style={{ color: "#b91c1c", marginTop: "1rem" }}>{error}</p>}

            <div style={{ marginTop: "1.5rem" }}>
                <button onClick={consent} disabled={busy} style={btn}>
                    {busy ? "Recording…" : "Consent to background check (DEV)"}
                </button>
            </div>
        </div>
    );
}
