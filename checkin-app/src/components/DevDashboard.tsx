"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useDebouncedValue } from "@mantine/hooks";
import { errorMessage, LoadError } from "@checkin/component-ui";
import { useIsDevInstance } from "@/components/EnvProvider";
import {
    macroFamily,
    macroProgram,
    macroEvent,
    macroCheckins,
    resetDevInstance,
    getRecentActivity,
    type ActionResult,
} from "@/lib/dev/actions";
import { useLoad } from "@/lib/api";
import { relTime } from "@/lib/time";

/**
 * The dev dashboard (docs/ops/dev-instance.md, "The dev dashboard") — a slide-up drawer from the bottom of the
 * screen, rendered only on the dev/local instance for a signed-in org member. Collapsed to a
 * grey "▲ Change mock account" handle so it never obscures the app; expands to the mock-account
 * (persona) picker + the macros + reset + ledger line. Impersonation provenance ("viewing as…"
 * + return-to-me) stays in the persistent DevImpersonationBar at the top. All actions go
 * through the fenced server actions / the persona-mint flow.
 */

interface Entry {
    action: string;
    realActor: string;
    detail: string | null;
    createdAt: string | Date;
}

interface PersonaOption {
    id: number;
    email: string;
    name: string | null;
    isSysadmin?: boolean;
}

function describe(e: Entry): string {
    const who = e.realActor;
    if (e.action === "reset") return `${who} reset`;
    if (e.action === "login") return `${who} signed in`;
    if (e.action === "impersonate") return `${who} impersonated ${e.detail ?? "a persona"}`;
    if (e.action.startsWith("macro:")) return `${who} ran ${e.action.slice(6)} macro`;
    return `${who} — ${e.action}`;
}

const MACROS: { label: string; action: () => Promise<ActionResult> }[] = [
    { label: "+ Family", action: macroFamily },
    { label: "+ Program", action: macroProgram },
    { label: "+ Event", action: macroEvent },
    { label: "+ Check-ins", action: macroCheckins },
];

export default function DevDashboard() {
    const { data: session } = useSession();
    const isDevInstance = useIsDevInstance();
    const router = useRouter();

    const [open, setOpen] = useState(false);
    const [confirmingReset, setConfirmingReset] = useState(false);
    const [toast, setToast] = useState<string | null>(null);
    const [activity, setActivity] = useState<Entry[]>([]);
    const [activityError, setActivityError] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [debouncedQuery] = useDebouncedValue(query.trim(), 200);
    const [switching, setSwitching] = useState(false);
    const [pending, startTransition] = useTransition();

    const signedIn = !!session?.user;

    const loadActivity = useCallback(() => {
        getRecentActivity(5)
            .then((entries) => { setActivity(entries); setActivityError(null); })
            .catch((e: unknown) => setActivityError(errorMessage(e)));
    }, []);

    useEffect(() => {
        if (!isDevInstance || !signedIn || !open) return;
        loadActivity();
    }, [isDevInstance, signedIn, open, loadActivity]);

    // Search the seeded @example.com personas (debounced). The server applies the suffix filter +
    // cap and narrows by `q`. Personas render by name, so searching by email is the reliable way
    // to reach one (e.g. "bg.reviewer" → "BG Reviewer"). Mounted on every page, so a 401 must not sign anyone out.
    const personasPath = isDevInstance && signedIn && open
        ? (debouncedQuery ? `/api/auth/dev-personas?q=${encodeURIComponent(debouncedQuery)}` : "/api/auth/dev-personas")
        : null;
    const personasLoad = useLoad<{ personas?: PersonaOption[] }>(personasPath, { keepPrevious: true, expireOn401: false });
    const personas = personasLoad.data?.personas ?? [];

    if (!isDevInstance || !signedIn) return null;

    const flash = (msg: string) => {
        setToast(msg);
        setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
    };

    const impersonate = (personaId: string) => {
        if (!personaId) return;
        setSwitching(true);
        // Land back on the page being viewed, re-rendered as the new persona.
        signIn("persona-mint", {
            personaId,
            mode: "impersonate",
            callbackUrl: window.location.pathname + window.location.search,
        });
    };

    // Mint a synthetic logged-out (guest) session: preview the signed-out UX while staying past the
    // dev org gate, with one-click "Return to me" via the DevImpersonationBar.
    const viewLoggedOut = () => {
        setSwitching(true);
        signIn("persona-mint", {
            mode: "logout",
            callbackUrl: window.location.pathname + window.location.search,
        });
    };

    const runMacro = (fn: () => Promise<ActionResult>) => {
        startTransition(async () => {
            try {
                const res = await fn();
                flash(`✅ ${res.summary}`);
                router.refresh();
                loadActivity();
            } catch {
                flash("⚠️ Action failed — are you a verified org member?");
            }
        });
    };

    const doReset = () => {
        setConfirmingReset(false);
        startTransition(async () => {
            try {
                const res = await resetDevInstance();
                if (!res.ok) {
                    flash(`⚠️ Reset reseeded the databases but could not link QuickBooks and Shopify: ${res.error}`);
                    return;
                }
                // The reset reseeds participants with fresh ids, so the current minted session is
                // now stale — sign out and let the user re-pick a persona against the clean DB.
                flash("✅ Reset complete — signing out to re-pick a persona…");
                setTimeout(() => signOut({ callbackUrl: "/" }), 1200);
            } catch {
                flash("⚠️ Reset failed");
            }
        });
    };

    const lastActivity = activity[0];
    const currentName = session.user.name || session.user.email;
    // Quick "View as admin" reuses the seeded isSysadmin persona (e.g. boardmember@example.com).
    const adminPersona = personas.find((p) => p.isSysadmin);

    return (
        <div
            style={{
                position: "fixed",
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 1000,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                pointerEvents: "none", // the full-width wrapper must not block the page
            }}
        >
            {/* Toast */}
            {toast && (
                <div
                    style={{
                        pointerEvents: "auto",
                        marginBottom: "0.5rem",
                        maxWidth: 360,
                        padding: "0.5rem 0.75rem",
                        borderRadius: 8,
                        background: "rgba(17, 24, 39, 0.95)",
                        color: "white",
                        fontSize: "0.8rem",
                        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
                    }}
                >
                    {toast}
                </div>
            )}

            {/* Collapsed handle: grey up arrow + "Change mock account" */}
            <button
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-label={open ? "Close the dev panel" : "Open the dev panel"}
                style={{
                    pointerEvents: "auto",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.45rem",
                    padding: "0.35rem 1.1rem",
                    borderRadius: "10px 10px 0 0",
                    background: "rgba(55, 65, 81, 0.92)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderBottom: "none",
                    color: "#d1d5db",
                    fontSize: "0.8rem",
                    cursor: "pointer",
                    boxShadow: "0 -2px 12px rgba(0,0,0,0.25)",
                }}
            >
                <span
                    aria-hidden
                    style={{
                        color: "#9ca3af",
                        display: "inline-block",
                        transition: "transform 0.2s ease",
                        transform: open ? "rotate(180deg)" : "none",
                        fontSize: "0.7rem",
                    }}
                >
                    ▲
                </span>
                Change mock account
                {pending && <span aria-hidden>⏳</span>}
            </button>

            {/* Slide-up panel: mock-account picker + macros */}
            <div
                style={{
                    pointerEvents: open ? "auto" : "none",
                    width: "min(680px, 100vw - 2rem)",
                    maxHeight: open ? "60vh" : 0,
                    overflow: open ? "auto" : "hidden",
                    transition: "max-height 0.25s ease",
                    borderRadius: "12px 12px 0 0",
                    background: "rgba(17, 24, 39, 0.97)",
                    borderTop: open ? panelEdge : "none",
                    borderLeft: open ? panelEdge : "none",
                    borderRight: open ? panelEdge : "none",
                    color: "white",
                    boxShadow: open ? "0 -8px 32px rgba(0,0,0,0.4)" : "none",
                }}
            >
                <div style={{ padding: "1rem", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem" }}>
                    {/* Mock account (impersonation) */}
                    <section>
                        <div style={sectionTitle}>Mock account</div>
                        <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.5rem" }}>
                            Currently <strong style={{ color: "#d1d5db" }}>{currentName}</strong>
                            {session.user.impersonatedBy ? <> (you are {session.user.impersonatedBy})</> : null}
                        </div>
                        {/* Quick sessions: one-click admin + logged-out, alongside the persona list. */}
                        <div style={{ display: "flex", gap: "0.35rem", marginBottom: "0.5rem" }}>
                            {adminPersona && (
                                <button
                                    onClick={() => impersonate(String(adminPersona.id))}
                                    disabled={switching}
                                    style={{ ...macroBtn(switching), flex: 1 }}
                                    title={`Sysadmin — ${adminPersona.email}`}
                                >
                                    🛡 Admin
                                </button>
                            )}
                            <button
                                onClick={viewLoggedOut}
                                disabled={switching}
                                style={{ ...macroBtn(switching), flex: 1 }}
                                title="Preview the signed-out experience (you can return to yourself)"
                            >
                                🔓 Logged out
                            </button>
                        </div>
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search personas by name or email…"
                            aria-label="Search test personas to impersonate"
                            style={{
                                width: "100%",
                                boxSizing: "border-box",
                                padding: "0.45rem 0.6rem",
                                marginBottom: "0.5rem",
                                borderRadius: 8,
                                background: "rgba(255,255,255,0.06)",
                                border: "1px solid rgba(255,255,255,0.18)",
                                color: "white",
                                fontSize: "0.8rem",
                            }}
                        />
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", maxHeight: "15rem", overflowY: "auto" }}>
                            {personasLoad.error && (
                                <LoadError what="the test personas" message={personasLoad.error} onRetry={personasLoad.reload} />
                            )}
                            {personasLoad.data && personas.length === 0 && (
                                <span style={{ fontSize: "0.78rem", color: "#9ca3af" }}>
                                    {query.trim()
                                        ? `No personas match “${query.trim()}”.`
                                        : "No personas yet — run the + Family macro or the seed."}
                                </span>
                            )}
                            {personas.map((p) => (
                                <button
                                    key={p.id}
                                    onClick={() => impersonate(String(p.id))}
                                    disabled={switching}
                                    style={{
                                        ...macroBtn(switching),
                                        display: "flex",
                                        flexDirection: "column",
                                        alignItems: "flex-start",
                                        gap: "0.1rem",
                                        textAlign: "left",
                                        overflow: "hidden",
                                        flexShrink: 0,
                                    }}
                                    title={p.email}
                                >
                                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
                                        🎭 {p.name || p.email}
                                    </span>
                                    {p.name && p.email && (
                                        <span style={{ fontSize: "0.68rem", color: "#9ca3af", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
                                            {p.email}
                                        </span>
                                    )}
                                </button>
                            ))}
                        </div>
                    </section>

                    {/* Macros + reset + ledger */}
                    <section>
                        <div style={sectionTitle}>Macros</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem", marginBottom: "0.9rem" }}>
                            {MACROS.map((m) => (
                                <button
                                    key={m.label}
                                    onClick={() => runMacro(m.action)}
                                    disabled={pending}
                                    style={macroBtn(pending)}
                                >
                                    {m.label}
                                </button>
                            ))}
                        </div>

                        <div style={{ fontSize: "0.72rem", color: "#9ca3af", marginBottom: "0.75rem", minHeight: "1rem" }}>
                            {activityError ? (
                                <LoadError what="the recent activity" message={activityError} onRetry={loadActivity} />
                            ) : lastActivity
                                ? `Last activity: ${describe(lastActivity)} ${relTime(lastActivity.createdAt)}`
                                : "No recorded activity yet"}
                        </div>

                        {confirmingReset ? (
                            <div style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.4)", borderRadius: 8, padding: "0.6rem" }}>
                                <div style={{ fontSize: "0.78rem", marginBottom: "0.5rem" }}>
                                    {activityError
                                        ? "Recent activity couldn't be checked, so someone may be using this instance. Reset anyway?"
                                        : lastActivity
                                        ? `${describe(lastActivity)} ${relTime(lastActivity.createdAt)}. Reset anyway?`
                                        : "Truncate all data and reseed the baseline?"}
                                </div>
                                <div style={{ display: "flex", gap: "0.4rem" }}>
                                    <button onClick={doReset} disabled={pending} style={{ ...dangerBtn, flex: 1 }}>
                                        {pending ? "Resetting…" : "Yes, reset"}
                                    </button>
                                    <button onClick={() => setConfirmingReset(false)} disabled={pending} style={{ ...macroBtn(false), flex: 1 }}>
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <button onClick={() => setConfirmingReset(true)} disabled={pending} style={{ ...dangerBtn, width: "100%" }}>
                                🔴 Reset dev instance
                            </button>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}

const panelEdge = "1px solid rgba(255,255,255,0.12)";

const sectionTitle: React.CSSProperties = {
    fontSize: "0.7rem",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "#9ca3af",
    marginBottom: "0.4rem",
};

function macroBtn(pending: boolean): React.CSSProperties {
    return {
        padding: "0.5rem",
        borderRadius: 8,
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.12)",
        color: "white",
        fontSize: "0.8rem",
        cursor: pending ? "wait" : "pointer",
        opacity: pending ? 0.6 : 1,
    };
}

const dangerBtn: React.CSSProperties = {
    padding: "0.5rem",
    borderRadius: 8,
    background: "rgba(239,68,68,0.85)",
    border: "1px solid rgba(239,68,68,1)",
    color: "white",
    fontSize: "0.8rem",
    fontWeight: 600,
    cursor: "pointer",
};
