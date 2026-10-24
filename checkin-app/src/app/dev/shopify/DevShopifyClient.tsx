"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface PendingProcess {
    id: number;
    household: string;
    isVolunteerFamily: boolean;
}

interface PendingEnrollment {
    programId: number;
    programName: string;
    personId: number;
    personName: string;
    hasVariant: boolean;
}

/**
 * Dev Shopify orders/paid mock UI. Picks a PENDING_PAYMENT membership process or
 * a PENDING program enrollment and fires a synthesized-but-real orders/paid
 * webhook at it (via /api/dev/shopify/orders-paid), driving it to ACTIVE the same
 * way a real Shopify payment would. Inline styles match the sibling dev tools
 * (dev/zoho-sign). Page 404s off a dev instance.
 */
export default function DevShopifyClient({
    hasVariant,
    processes,
    enrollments,
}: {
    hasVariant: boolean;
    processes: PendingProcess[];
    enrollments: PendingEnrollment[];
}) {
    const router = useRouter();
    // Busy key is unique per row across both tables: "m:<id>" / "p:<programId>:<personId>".
    const [busy, setBusy] = useState<string | null>(null);
    const [result, setResult] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function fire(key: string, body: unknown, describe: (data: Record<string, unknown>) => string) {
        setBusy(key);
        setError(null);
        setResult(null);
        try {
            const res = await fetch("/api/dev/shopify/orders-paid", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(data.error ? `${data.error} (${res.status})` : `Webhook failed (${res.status}). Check server logs.`);
                return;
            }
            setResult(describe(data));
            // The fired row is no longer awaiting payment — refresh the
            // server-rendered lists so it (and its 404-on-re-click) disappears.
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
        }
    }

    const btn: React.CSSProperties = {
        padding: "0.4rem 0.9rem",
        borderRadius: 6,
        border: "none",
        background: "#059669",
        color: "#fff",
        fontWeight: 600,
        cursor: "pointer",
    };
    const th: React.CSSProperties = { padding: "0.4rem", textAlign: "left" };

    return (
        <div style={{ maxWidth: 720 }}>
            <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>Shopify orders/paid (mock)</h1>
            <p style={{ opacity: 0.7, fontSize: "0.85rem", marginTop: "0.5rem" }}>
                Shopify is mocked on this instance (no store credentials). Firing a payment sends a
                real signed <code>orders/paid</code> webhook — <strong>DEV, NO REAL MONEY</strong>.
            </p>

            {error && <p style={{ color: "#b91c1c", marginTop: "1rem" }}>{error}</p>}
            {result && <p style={{ color: "#059669", marginTop: "1rem" }}>{result}</p>}

            <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginTop: "1.75rem" }}>Membership applications</h2>
            {!hasVariant && (
                <p style={{ color: "#b45309", marginTop: "0.5rem", fontSize: "0.85rem" }}>
                    No membership variant configured. Set one in <strong>Settings → Membership</strong> first —
                    the mock only needs <em>a</em> value here (any string): it signs a payload carrying that id and
                    the inbound webhook matches it against this same setting, so it&apos;s a closed loop.
                    On a real dev store, set this to the store&apos;s actual variant id instead. Without it the
                    webhook lands as a no-membership-item anomaly instead of activating.
                </p>
            )}
            {processes.length === 0 ? (
                <p style={{ fontSize: "0.9rem", opacity: 0.7 }}>No applications awaiting payment.</p>
            ) : (
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                    <thead>
                        <tr style={{ fontSize: "0.8rem", opacity: 0.6 }}>
                            <th style={th}>Process</th>
                            <th style={th}>Household</th>
                            <th style={th}>Tier</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {processes.map((p) => {
                            const key = `m:${p.id}`;
                            return (
                                <tr key={key} style={{ borderTop: "1px solid #e5e7eb" }}>
                                    <td style={{ padding: "0.4rem" }}>#{p.id}</td>
                                    <td style={{ padding: "0.4rem" }}>{p.household}</td>
                                    <td style={{ padding: "0.4rem" }}>{p.isVolunteerFamily ? "Volunteer" : "Normal"}</td>
                                    <td style={{ padding: "0.4rem", textAlign: "right" }}>
                                        <button
                                            onClick={() => fire(key, { processId: p.id }, (d) => `Fired for process ${p.id} → status ${d.status ?? "unknown"}`)}
                                            disabled={busy !== null}
                                            style={{ ...btn, opacity: busy !== null ? 0.5 : 1 }}
                                        >
                                            {busy === key ? "Firing…" : "Fire orders/paid"}
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}

            <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginTop: "1.75rem" }}>Program enrollments</h2>
            {enrollments.length === 0 ? (
                <p style={{ fontSize: "0.9rem", opacity: 0.7 }}>No enrollments awaiting payment.</p>
            ) : (
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                    <thead>
                        <tr style={{ fontSize: "0.8rem", opacity: 0.6 }}>
                            <th style={th}>Program</th>
                            <th style={th}>Participant</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {enrollments.map((e) => {
                            const key = `p:${e.programId}:${e.personId}`;
                            return (
                                <tr key={key} style={{ borderTop: "1px solid #e5e7eb" }}>
                                    <td style={{ padding: "0.4rem" }}>
                                        #{e.programId} {e.programName}
                                        {!e.hasVariant && (
                                            <span style={{ color: "#b45309", fontSize: "0.75rem", marginLeft: "0.4rem" }}>
                                                (no variant — set one in program-ops)
                                            </span>
                                        )}
                                    </td>
                                    <td style={{ padding: "0.4rem" }}>{e.personName}</td>
                                    <td style={{ padding: "0.4rem", textAlign: "right" }}>
                                        <button
                                            onClick={() =>
                                                fire(
                                                    key,
                                                    { programId: e.programId, participantIds: [e.personId] },
                                                    (d) => {
                                                        const parts = (d.participants as { personId: number; status: string }[] | undefined) ?? [];
                                                        const me = parts.find((p) => p.personId === e.personId);
                                                        return `Fired for ${e.personName} → status ${me?.status ?? "unknown"}`;
                                                    },
                                                )
                                            }
                                            disabled={busy !== null || !e.hasVariant}
                                            style={{ ...btn, opacity: busy !== null || !e.hasVariant ? 0.5 : 1 }}
                                            title={e.hasVariant ? undefined : "Program has no Shopify variant; webhook would leave the participant PENDING"}
                                        >
                                            {busy === key ? "Firing…" : "Fire orders/paid"}
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}
