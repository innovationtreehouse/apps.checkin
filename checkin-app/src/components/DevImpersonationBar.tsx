"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession, signIn } from "next-auth/react";
import { useIsDevInstance } from "@/components/EnvProvider";

/**
 * Persistent dev-instance bar (docs/ops/dev-instance.md, "Impersonation" + "The dev dashboard").
 *
 * Rendered only on the dev/local instance for a signed-in user. Shows who you really are while
 * impersonating (derived from the inert `impersonatedBy` claim) and lets you return to yourself.
 * Switching personas lives in the bottom "Change mock account" drawer (DevDashboard); both go
 * through the single persona-mint flow.
 */
export default function DevImpersonationBar() {
    // useSearchParams needs a Suspense boundary (mirrors AppFrame's AppFrameInner wrap).
    return (
        <Suspense fallback={null}>
            <DevImpersonationBarInner />
        </Suspense>
    );
}

function DevImpersonationBarInner() {
    const { data: session } = useSession();
    const isDevInstance = useIsDevInstance();
    const searchParams = useSearchParams();
    const [busy, setBusy] = useState(false);

    const signedIn = !!session?.user;

    // Kiosk mode strips all chrome (see AppFrame); the dev bar must vanish too, else it
    // overlaps the full-screen kiosk view (e.g. Live Certifications). Same condition as AppFrame.
    const isKioskMode = searchParams.get("mode") === "kiosk" || !!searchParams.get("sig");
    if (isKioskMode) return null;

    if (!isDevInstance || !signedIn) return null;

    const impersonatedBy = session.user.impersonatedBy;
    const currentName = session.user.name || session.user.email;

    const returnToMe = () => {
        setBusy(true);
        // Land back on the page being viewed, re-rendered as the real identity.
        signIn("persona-mint", {
            mode: "return",
            callbackUrl: window.location.pathname + window.location.search,
        });
    };

    return (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                flexWrap: "wrap",
                padding: "0.5rem 1rem",
                background: impersonatedBy ? "rgba(236, 72, 153, 0.15)" : "rgba(59, 130, 246, 0.12)",
                borderBottom: `1px solid ${impersonatedBy ? "rgba(236, 72, 153, 0.4)" : "rgba(59, 130, 246, 0.3)"}`,
                fontSize: "0.85rem",
            }}
        >
            <span style={{ fontWeight: 600 }}>
                {impersonatedBy ? (
                    <>🎭 Viewing as <strong>{currentName}</strong> — you are {impersonatedBy}</>
                ) : (
                    <>🛠 Dev instance — signed in as <strong>{currentName}</strong></>
                )}
            </span>

            {impersonatedBy && (
                <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <button
                        type="button"
                        onClick={returnToMe}
                        disabled={busy}
                        style={{ padding: "0.25rem 0.75rem", cursor: busy ? "wait" : "pointer" }}
                    >
                        {busy ? "Returning…" : "Return to me"}
                    </button>
                </span>
            )}
        </div>
    );
}
