"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Badge,
    Button,
    Card,
    Center,
    Group,
    Loader,
    Modal,
    Radio,
    Stack,
    Text,
    Textarea,
    Title,
    Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { AlertBanner, type AlertTone } from "@/components/admin/AlertBanner";
import { TrustedAdultContact } from "@/components/TrustedAdultContact";
import { useRequireRole } from "@/hooks/useRequireRole";
import { isTrustedAdultConflict } from "@/lib/trusted-adult/conflict";
import { notifyNavRefresh } from "@/lib/nav-refresh";

interface Review {
    id: number;
    kind: string;
    status: string;
    decision: string | null;
    decisionNote: string | null;
    sharedNote: string | null;
    effectiveFrom: string | null;
    reviewBy: string | null;
    proposedName: string | null;
    proposedPhone: string | null;
    proposedEmail: string | null;
    proposedContext: string | null;
    createdAt: string;
}
interface PersonRef {
    id: number;
    name: string | null;
    email: string | null;
}
interface HouseholdRef {
    id: number;
    name: string | null;
    householdMembers: PersonRef[];
}
interface TrustedAdult {
    id: number;
    trustedAdultName: string | null;
    trustedAdultPhone: string | null;
    trustedAdultEmail: string | null;
    familyContext: string;
    origin: string;
    createdAt: string;
    household: HouseholdRef | null;
    trustedAdultPerson: PersonRef | null;
    reviews: Review[];
}

const STATUS_COLORS: Record<string, string> = {
    PENDING_BOARD_REVIEW: "yellow",
    PENDING_SUBJECT_ACTION: "orange",
    APPROVED: "green",
    DENIED: "red",
    EXPIRED: "gray",
    REVOKED: "gray",
};
const label = (s: string) => s.replace(/_/g, " ");

// The board needs to know the LAST DECISION on a trusted adult so it can update it —
// not merely whether this row is a "renewal". A withdrawal is an interim state that
// must NOT hide the prior decision: DENIED → withdrawn → resubmitted should still read
// "Previously denied", not "Renewal". `decision` survives a withdrawal (withdraw only
// flips status to REVOKED), so walking the reviews before the in-flight one for the
// first non-null `decision` gives the true last board decision and skips withdraw-only
// (decision-less) states. Null → a fresh disclosure or a plain withdraw+resubmit, where
// the board needs no prior-decision context.
const PRIOR_DECISION_META: Record<string, { text: string; color: string }> = {
    APPROVE: { text: "Renewal", color: "blue" },
    DENY: { text: "Previously denied", color: "red" },
    REQUEST_INFO: { text: "Previously: more info requested", color: "orange" },
};

function priorDecisionReview(reviews: Review[]): Review | null {
    // reviews are id-desc; reviews[0] is the current/in-flight review.
    for (let i = 1; i < reviews.length; i++) {
        if (reviews[i].decision) return reviews[i];
    }
    return null;
}

const daysBetween = (aIso: string, bIso: string) =>
    Math.round((new Date(aIso).getTime() - new Date(bIso).getTime()) / 86400000);

export default function AdminTrustedAdultsPage() {
    const { ready, loading: authLoading, user } = useRequireRole(["isSysadmin", "isBoardMember"]);
    const [items, setItems] = useState<TrustedAdult[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [shared, setShared] = useState<Record<number, string>>({});
    // When a prior board note exists, force the board to pick "reuse" or "write new"
    // before approving — no default, so submitting is a deliberate choice, not a stale carry-over.
    const [noteChoice, setNoteChoice] = useState<Record<number, "reuse" | "new">>({});
    // Per-review confirmation, rendered card-local so the notice stays next to the
    // button that triggered it (a single page-top banner scrolls off-screen on long queues).
    const [notices, setNotices] = useState<Record<number, { text: string; tone: AlertTone }>>({});
    const clearNotice = (id: number) =>
        setNotices((n) => { const c = { ...n }; delete c[id]; return c; });
    // Native in-app prompt (replaces window.prompt): cancel closes without acting,
    // so no decision fires unless the board submits a note.
    const [prompt, setPrompt] = useState<{ title: string; onSubmit: (note: string) => void } | null>(null);
    const [promptVal, setPromptVal] = useState("");
    const openPrompt = (cfg: { title: string; onSubmit: (note: string) => void }) => {
        setPromptVal("");
        setPrompt(cfg);
    };

    const loadList = useCallback(() => fetch("/api/safety/trusted-adults")
        .then(async (res) => {
            if (res.ok) {
                const data = await res.json();
                setItems(data.trustedAdults || []);
            }
        })
        .finally(() => {
            setLoading(false);
        }),
    []);

    const load = () => {
        setLoading(true);
        return loadList();
    };

    useEffect(() => {
        if (ready) loadList();
    }, [ready, loadList]);

    const decide = async (reviewId: number, decision: string, extra?: Record<string, unknown>) => {
        setBusyId(reviewId);
        clearNotice(reviewId);
        try {
            const res = await fetch("/api/safety/trusted-adults/decision", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reviewId, decision, ...extra }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (body.code === "wrong_phase") {
                    notifications.show({ color: "red", message: body.error ?? "This review is no longer awaiting board review.", autoClose: 4000 });
                    await load();
                } else {
                    setNotices((n) => ({ ...n, [reviewId]: { text: body.error ?? "Decision failed.", tone: "error" } }));
                }
            } else {
                notifications.show({ message: `Recorded: ${label(body.status)}.` });
                await load();
                notifyNavRefresh();
            }
        } finally {
            setBusyId(null);
        }
    };

    const override = async (reviewId: number, action: string, extra?: Record<string, unknown>) => {
        setBusyId(reviewId);
        clearNotice(reviewId);
        try {
            const res = await fetch("/api/safety/trusted-adults/override", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reviewId, action, ...extra }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setNotices((n) => ({ ...n, [reviewId]: { text: body.error ?? "Override failed.", tone: "error" } }));
            } else {
                // Override deliberately shows no success notice — just reload.
                await load();
                notifyNavRefresh();
            }
        } finally {
            setBusyId(null);
        }
    };

    if (authLoading || loading) {
        return (
            <Center h={200}>
                <Loader />
            </Center>
        );
    }

    if (!ready) return null;

    return (
        <Stack>
            <Modal opened={!!prompt} onClose={() => setPrompt(null)} title={prompt?.title} centered>
                <Textarea
                    data-autofocus
                    autosize
                    minRows={3}
                    value={promptVal}
                    onChange={(e) => setPromptVal(e.currentTarget.value)}
                />
                <Group justify="flex-end" mt="md">
                    <Button variant="default" onClick={() => setPrompt(null)}>Cancel</Button>
                    <Button
                        disabled={!promptVal.trim()}
                        onClick={() => { prompt?.onSubmit(promptVal); setPrompt(null); }}
                    >
                        Submit
                    </Button>
                </Group>
            </Modal>
            <div>
                <Title order={2}>Trusted Adults — Board Review</Title>
                <Text c="dimmed" size="sm">
                    Household-disclosed trusted adults (a.k.a. dual relationships) awaiting review, awaiting the family,
                    or expired. A single board member settles each. Approving requires a shared note that front-desk
                    keyholders and program leads will see.
                </Text>
            </div>

            {items.length === 0 && <Text c="dimmed">Nothing in the queue.</Text>}

            {items.map((ta) => {
                const latest = ta.reviews[0];
                const status = latest?.status ?? "PENDING_BOARD_REVIEW";
                const pending = status === "PENDING_BOARD_REVIEW";
                const sharedVal = latest ? shared[latest.id] ?? "" : "";
                const prior = priorDecisionReview(ta.reviews);
                const priorMeta = prior?.decision ? PRIOR_DECISION_META[prior.decision] : null;
                // A MODIFIED resubmission carries CHANGED facts (vs a plain renewal that
                // reuses them). Flag it on top of the prior-decision text, e.g.
                // "Renewal — info updated" / "Previously denied — info updated".
                const infoUpdated = latest?.kind === "MODIFIED";
                const changeBadge = priorMeta
                    ? { text: priorMeta.text + (infoUpdated ? " — info updated" : ""), color: priorMeta.color }
                    : infoUpdated
                        ? { text: "Info updated", color: "blue" }
                        : null;
                // "Previously dispositioned" note the board sent to staff — only APPROVE sets a
                // sharedNote. When present on a renewal, offer to re-use it (gated by a radio).
                const priorNote = prior?.sharedNote?.trim() || null;
                const choice = latest ? noteChoice[latest.id] : undefined;
                const needsChoice = pending && !!priorNote;
                // A renewal whose prior approval lapsed: how long it sat expired before
                // this resubmission. A long lapse means it's almost a fresh disclosure —
                // reviewBy is the approval's expiry date; gap to the resubmit is the age.
                const lapsedDays =
                    prior?.decision === "APPROVE" && prior.reviewBy && latest
                        ? daysBetween(latest.createdAt, prior.reviewBy)
                        : null;
                // Conflict of interest: can't review your own household's trusted adult, nor
                // one where you are the counterparty. Backend enforces the same rule.
                const isSelf = isTrustedAdultConflict({
                    actorParticipantId: user?.id,
                    actorHouseholdId: user?.householdId,
                    taHouseholdId: ta.household?.id,
                    taTrustedAdultPersonId: ta.trustedAdultPerson?.id,
                });
                // A live approval exists underneath this pending review (mirrors
                // /operational: any APPROVED review = still authorized). Then denying is
                // ambiguous — reject just this submission, or the adult outright — so the
                // board gets both "Deny" (approval stands) and "Deny & Revoke".
                const hasLivePriorApproval = ta.reviews.some((r) => r.status === "APPROVED");
                return (
                    <Card key={ta.id} withBorder radius="md" padding="md">
                        <Group gap="xs">
                            <Text fw={600}>{ta.household?.name || `Household ${ta.household?.id}`}</Text>
                            <Text c="dimmed">→</Text>
                            <Text>{ta.trustedAdultPerson?.name || ta.trustedAdultName || "trusted adult"}</Text>
                            <Badge color={STATUS_COLORS[status] ?? "gray"}>{label(status)}</Badge>
                            {changeBadge && <Badge variant="filled" color={changeBadge.color}>{changeBadge.text}</Badge>}
                        </Group>
                        <TrustedAdultContact phone={ta.trustedAdultPhone} email={ta.trustedAdultEmail} />
                        <Text size="sm" mt={6}><b>Family context (board only):</b> {ta.familyContext}</Text>
                        {latest?.kind === "MODIFIED" && (
                            <Card withBorder radius="sm" padding="xs" mt={6} bg="var(--mantine-color-blue-light)">
                                <Text size="sm" fw={600} c="blue">Proposed changes — not in effect until you approve</Text>
                                <Text size="sm">Name: {latest.proposedName}</Text>
                                <TrustedAdultContact phone={latest.proposedPhone} email={latest.proposedEmail} />
                                <Text size="sm">Context: {latest.proposedContext}</Text>
                                <Text size="xs" c="dimmed" mt={2}>The facts above are the family&apos;s current record; these replace them on approval.</Text>
                            </Card>
                        )}
                        {latest?.sharedNote && (
                            <Text size="sm" c="teal" mt={2}>Shared note (keyholders/program leads): {latest.sharedNote}</Text>
                        )}
                        {ta.household?.householdMembers?.length ? (
                            <Text size="xs" c="dimmed" mt={2}>
                                Leads: {ta.household.householdMembers.map((p) => p.name || p.email).join(", ")}
                            </Text>
                        ) : null}
                        {latest?.reviewBy && (
                            <Text size="xs" c="dimmed" mt={2}>Review by {latest.reviewBy.slice(0, 10)}</Text>
                        )}
                        {lapsedDays !== null && lapsedDays > 0 && (
                            <Text size="xs" c={lapsedDays > 365 ? "orange" : "dimmed"} mt={2}>
                                Prior approval expired {prior!.reviewBy!.slice(0, 10)} · lapsed {lapsedDays} day{lapsedDays === 1 ? "" : "s"} before this resubmission
                                {lapsedDays > 365 ? " — treat as near-new" : ""}
                            </Text>
                        )}
                        <Text size="xs" c="dimmed" mt={2}>
                            Disclosed {ta.createdAt.slice(0, 10)} · {label(ta.origin)}
                        </Text>

                        {pending && latest && (
                            <Stack mt="md" gap="xs">
                                {priorNote && (
                                    <Radio.Group
                                        label="This trusted adult was previously dispositioned. Re-use the prior shared note, or write a new one?"
                                        withAsterisk
                                        value={choice ?? null}
                                        onChange={(v) => {
                                            const c = v as "reuse" | "new";
                                            setNoteChoice((m) => ({ ...m, [latest.id]: c }));
                                            // reuse -> load the prior note; new -> clear for fresh entry.
                                            setShared((s) => ({ ...s, [latest.id]: c === "reuse" ? priorNote : "" }));
                                        }}
                                    >
                                        <Stack gap={4} mt={4}>
                                            <Radio value="reuse" label={`Re-use existing message: “${priorNote}”`} />
                                            <Radio value="new" label="Write a new message" />
                                        </Stack>
                                    </Radio.Group>
                                )}
                                <Textarea
                                    withAsterisk
                                    label="Shared note — what keyholders & program leads should know (required to approve)"
                                    placeholder="e.g. Grandma (Jane Doe) may pick up Bobby and Sue."
                                    autosize
                                    minRows={2}
                                    // Until a choice is made on a previously-dispositioned item, keep the box locked
                                    // so the board can't sidestep the reuse/new decision.
                                    disabled={needsChoice && !choice}
                                    value={sharedVal}
                                    onChange={(e) => { const value = e.currentTarget.value; setShared((s) => ({ ...s, [latest.id]: value })); }}
                                />
                                <Tooltip
                                    label="You can't review your own household's trusted adult — another board member must decide."
                                    multiline w={260}
                                    disabled={!isSelf}
                                >
                                    <Group gap="xs">
                                        <Tooltip
                                            label={needsChoice && !choice ? "Choose re-use or write a new message first" : "Needs Shared Note to Approve"}
                                            disabled={isSelf || (!!sharedVal.trim() && !(needsChoice && !choice))}
                                        >
                                            <span>
                                                <Button
                                                    size="xs" fz={15}
                                                    loading={busyId === latest.id}
                                                    disabled={isSelf || !sharedVal.trim() || (needsChoice && !choice)}
                                                    onClick={() => decide(latest.id, "APPROVE", { sharedNote: sharedVal })}
                                                >
                                                    Approve
                                                </Button>
                                            </span>
                                        </Tooltip>
                                        <Tooltip label="Reject this submission; the existing approval stays in effect." disabled={isSelf || !hasLivePriorApproval} multiline w={260}>
                                            <Button size="xs" fz={15} color="red" loading={busyId === latest.id} disabled={isSelf} onClick={() => decide(latest.id, "DENY")}>
                                                Deny
                                            </Button>
                                        </Tooltip>
                                        {hasLivePriorApproval && (
                                            <Tooltip label="Reject the changes AND revoke the existing approval — the adult is no longer authorized." multiline w={260} disabled={isSelf}>
                                                <Button size="xs" fz={15} color="red" variant="filled" loading={busyId === latest.id} disabled={isSelf} onClick={() => decide(latest.id, "DENY", { revokePriorApprovals: true })}>
                                                    Deny &amp; Revoke
                                                </Button>
                                            </Tooltip>
                                        )}
                                        <Button
                                            size="xs" fz={15}
                                            variant="light"
                                            loading={busyId === latest.id}
                                            disabled={isSelf}
                                            onClick={() => openPrompt({
                                                title: "What information do you need from the family?",
                                                onSubmit: (note) => decide(latest.id, "REQUEST_INFO", { note }),
                                            })}
                                        >
                                            Request info
                                        </Button>
                                    </Group>
                                </Tooltip>
                            </Stack>
                        )}

                        {latest && !pending && status !== "REVOKED" && (
                            <Group gap="xs" mt="md">
                                <Text size="xs" c="dimmed">Override:</Text>
                                <Button
                                    size="xs" fz={15}
                                    variant="subtle"
                                    disabled={isSelf}
                                    loading={busyId === latest.id}
                                    onClick={() => openPrompt({
                                        title: "Shared note (required to force-approve)",
                                        onSubmit: (note) => override(latest.id, "approve", { sharedNote: note }),
                                    })}
                                >
                                    Force approve
                                </Button>
                                <Button size="xs" fz={15} variant="subtle" color="red" disabled={isSelf} loading={busyId === latest.id} onClick={() => override(latest.id, "deny")}>
                                    Force deny
                                </Button>
                                <Button size="xs" fz={15} variant="subtle" color="gray" disabled={isSelf} loading={busyId === latest.id} onClick={() => override(latest.id, "revoke")}>
                                    Revoke
                                </Button>
                            </Group>
                        )}

                        {latest && notices[latest.id] && (
                            <AlertBanner
                                message={notices[latest.id].text}
                                tone={notices[latest.id].tone}
                                mt="xs"
                                onClose={() => clearNotice(latest.id)}
                            />
                        )}
                    </Card>
                );
            })}
        </Stack>
    );
}
