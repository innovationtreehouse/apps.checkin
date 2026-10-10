"use client";

import { useEffect, useState, useCallback } from "react";
import {
    Alert,
    Badge,
    Button,
    Card,
    Group,
    Modal,
    Stack,
    Text,
    Textarea,
    TextInput,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { IconAlertTriangle, IconPlus } from "@tabler/icons-react";
import { normalizePhone, isValidEmail } from "@/lib/emergencyContacts/identity";
import { TrustedAdultContact } from "@/components/TrustedAdultContact";

const STATUS_META: Record<string, { label: string; color: string }> = {
    PENDING_BOARD_REVIEW: { label: "Awaiting board review", color: "yellow" },
    PENDING_SUBJECT_ACTION: { label: "Board needs more info — see email", color: "orange" },
    APPROVED: { label: "Approved", color: "treehouseGreen" },
    DENIED: { label: "Denied", color: "red" },
    EXPIRED: { label: "Expired", color: "gray" },
    REVOKED: { label: "Withdrawn", color: "gray" },
};

interface Review {
    id: number;
    kind: string;
    status: string;
    sharedNote: string | null;
    effectiveFrom: string | null;
    reviewBy: string | null;
    proposedName: string | null;
    proposedPhone: string | null;
    proposedEmail: string | null;
    proposedContext: string | null;
    createdAt: string;
}
interface TrustedAdult {
    id: number;
    trustedAdultName: string | null;
    trustedAdultPhone: string | null;
    trustedAdultEmail: string | null;
    familyContext: string;
    createdAt: string;
    reviews: Review[];
}

const EXPIRING_SOON_DAYS = 30;

export default function TrustedAdultPanel() {
    const [items, setItems] = useState<TrustedAdult[]>([]);
    const [now] = useState(() => Date.now());
    const [loading, setLoading] = useState(true);
    const [opened, { open, close }] = useDisclosure(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [attempted, setAttempted] = useState(false);

    const [trustedAdultName, setTrustedAdultName] = useState("");
    const [trustedAdultPhone, setTrustedAdultPhone] = useState("");
    const [trustedAdultEmail, setTrustedAdultEmail] = useState("");
    const [familyContext, setFamilyContext] = useState("");
    // Set while resubmitting an EXISTING trusted adult with edited info; null for a
    // fresh add. Drives the endpoint and the modal's copy.
    const [resubmitId, setResubmitId] = useState<number | null>(null);

    const closeModal = useCallback(() => {
        setAttempted(false);
        setResubmitId(null);
        close();
    }, [close]);

    // Open the modal blank for a new disclosure.
    const startAdd = useCallback(() => {
        setResubmitId(null);
        setTrustedAdultName("");
        setTrustedAdultPhone("");
        setTrustedAdultEmail("");
        setFamilyContext("");
        setAttempted(false);
        setError(null);
        open();
    }, [open]);

    // Open the modal pre-filled with the trusted adult's current facts, to resubmit
    // with changes. The prior approval (if any) stays live until the board approves.
    const startResubmit = useCallback((ta: TrustedAdult) => {
        setResubmitId(ta.id);
        setTrustedAdultName(ta.trustedAdultName ?? "");
        setTrustedAdultPhone(ta.trustedAdultPhone ?? "");
        setTrustedAdultEmail(ta.trustedAdultEmail ?? "");
        setFamilyContext(ta.familyContext ?? "");
        setAttempted(false);
        setError(null);
        open();
    }, [open]);

    const load = useCallback(() => {
        setLoading(true);
        fetch("/api/trusted-adults/mine")
            .then((r) => r.json())
            .then((d) => setItems(d.trustedAdults ?? []))
            .catch((err) => console.error("Failed to load your trusted adults:", err))
            .finally(() => setLoading(false));
    }, []);

    useEffect(load, [load]);

    async function submit() {
        setSubmitting(true);
        setError(null);
        try {
            const url = resubmitId ? `/api/trusted-adults/${resubmitId}/resubmit` : "/api/trusted-adults";
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ trustedAdultName, trustedAdultPhone, trustedAdultEmail, familyContext }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                setError(body.error ?? "Could not submit.");
                return;
            }
            close();
            setResubmitId(null);
            setTrustedAdultName("");
            setTrustedAdultPhone("");
            setTrustedAdultEmail("");
            setFamilyContext("");
            setAttempted(false);
            load();
        } finally {
            setSubmitting(false);
        }
    }

    async function act(id: number, action: "renew" | "withdraw" | "hide", payload?: Record<string, unknown>) {
        const res = await fetch(`/api/trusted-adults/${id}/${action}`, {
            method: "POST",
            ...(payload ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}),
        });
        if (res.ok) load();
        else {
            const body = await res.json().catch(() => ({}));
            setError(body.error ?? "Action failed.");
        }
    }

    // Permanently hides a withdrawn trusted adult from the household's view. The
    // record is kept for the board/audit — confirm because it can't be undone here.
    function confirmDelete(ta: TrustedAdult) {
        modals.openConfirmModal({
            title: "Delete this trusted adult?",
            children: (
                <Text size="sm">
                    This permanently removes <strong>{ta.trustedAdultName || "this trusted adult"}</strong> from your
                    list. You won&apos;t see it again. The board keeps a record for its files.
                </Text>
            ),
            labels: { confirm: "Delete", cancel: "Cancel" },
            confirmProps: { color: "red" },
            onConfirm: () => act(ta.id, "hide"),
        });
    }

    // Validate phone and email independently so both light up at once when both
    // are wrong. At least one contact method is required. Errors surface only
    // after a submit attempt — never while typing.
    const phoneTrim = trustedAdultPhone.trim();
    const emailTrim = trustedAdultEmail.trim();
    const missingContact = !phoneTrim && !emailTrim;
    const phoneBad = !!phoneTrim && normalizePhone(phoneTrim).length < 10;
    const emailBad = !!emailTrim && !isValidEmail(emailTrim);
    const contactInvalid = missingContact || phoneBad || emailBad;

    const nameError = attempted && !trustedAdultName.trim() ? "Enter the trusted adult's name." : undefined;
    const phoneError = attempted && phoneBad ? "That phone number doesn't look right."
        : attempted && missingContact ? "Enter a phone number or an email — at least one."
            : undefined;
    const emailError = attempted && emailBad ? "That email address doesn't look right." : undefined;
    const contextError = attempted && !familyContext.trim() ? "Add the board context." : undefined;

    return (
        <Stack gap="sm">
            <Group justify="space-between" align="flex-start">
                <Text size="sm" c="dimmed" style={{ maxWidth: 520 }}>
                    Name an adult outside your household who the board should know about (e.g. who may pick up your
                    kids). The board reviews each one; an approval is valid for one year.
                </Text>
                <Button size="xs" fz={15} leftSection={<IconPlus size={14} />} onClick={startAdd} style={{ flexShrink: 0 }}>
                    Add a trusted adult
                </Button>
            </Group>

            {error && (
                <Alert color="red" icon={<IconAlertTriangle size={16} />} withCloseButton onClose={() => setError(null)}>
                    {error}
                </Alert>
            )}

            {loading && <Text c="dimmed" size="sm">Loading…</Text>}
            {!loading && items.length === 0 && (
                <Text c="dimmed" size="sm">No trusted adults added yet.</Text>
            )}

            {items.map((ta) => {
                const latest = ta.reviews[0];
                // Live approval wins: mirror /operational — while ANY review is APPROVED the
                // adult is still authorized, even if a newer change is pending or was denied.
                // That newer review is a footnote, not the headline.
                const liveApproval = ta.reviews.find((r) => r.status === "APPROVED") ?? null;
                const latestPending = !!latest && (latest.status === "PENDING_BOARD_REVIEW" || latest.status === "PENDING_SUBJECT_ACTION");
                const changePending = !!liveApproval && latestPending;
                const changeDeclined = !!liveApproval && latest?.status === "DENIED";
                const effectiveStatus = liveApproval ? "APPROVED" : (latest?.status ?? "PENDING_BOARD_REVIEW");
                const meta = STATUS_META[effectiveStatus] ?? { label: effectiveStatus, color: "gray" };
                // Dates + shared note come from the operative review: the live approval when
                // there is one, otherwise the latest.
                const source = liveApproval ?? latest;
                const reviewBy = source?.reviewBy ? new Date(source.reviewBy) : null;
                const expiringSoon =
                    reviewBy && effectiveStatus === "APPROVED" && reviewBy.getTime() - now < EXPIRING_SOON_DAYS * 86400000;
                const canResubmit = !changePending && (!!liveApproval || ["EXPIRED", "DENIED", "REVOKED"].includes(latest?.status ?? ""));

                return (
                    <Card key={ta.id} withBorder radius="md" padding="sm">
                        <Group justify="space-between" align="flex-start" wrap="nowrap">
                            <div>
                                <Group gap="xs">
                                    <Text fw={600} size="sm">{ta.trustedAdultName || "Trusted adult"}</Text>
                                    <Badge color={meta.color} size="sm">{meta.label}</Badge>
                                </Group>
                                <TrustedAdultContact phone={ta.trustedAdultPhone} email={ta.trustedAdultEmail} />
                                <Text size="sm" mt={4}>{ta.familyContext}</Text>
                                {changePending && latest?.kind === "MODIFIED" && (
                                    <Card withBorder radius="sm" padding="xs" mt={6} bg="var(--mantine-color-blue-light)">
                                        <Text size="xs" fw={600} c="blue">Pending update — awaiting board review</Text>
                                        <Text size="sm">{latest.proposedName}</Text>
                                        <TrustedAdultContact phone={latest.proposedPhone} email={latest.proposedEmail} />
                                        <Text size="sm">{latest.proposedContext}</Text>
                                        <Text size="xs" c="dimmed" mt={2}>Your existing approval stays in effect until the board reviews this.</Text>
                                    </Card>
                                )}
                                {changePending && latest?.kind !== "MODIFIED" && (
                                    <Text size="xs" c="blue" mt={4}>Resubmission awaiting board review — your approval stays in effect meanwhile.</Text>
                                )}
                                {changeDeclined && (
                                    <Text size="xs" c="orange" mt={4}>The board declined your recent change. Your prior approval below stays in effect.</Text>
                                )}
                                {source?.sharedNote && (
                                    <Text size="sm" mt={4} c="teal">
                                        Board note (seen by front desk & program leads): {source.sharedNote}
                                    </Text>
                                )}
                                {reviewBy && effectiveStatus === "APPROVED" && (
                                    <Text size="xs" c={expiringSoon ? "orange" : "dimmed"} mt={4}>
                                        Valid until {reviewBy.toISOString().slice(0, 10)}
                                        {expiringSoon ? " — expiring soon" : ""}
                                    </Text>
                                )}
                            </div>
                            <Group gap="xs" style={{ flexShrink: 0 }}>
                                {canResubmit && (
                                    <>
                                        <Button size="xs" fz={15} variant="light" onClick={() => act(ta.id, "renew")}>
                                            Resubmit (same info)
                                        </Button>
                                        <Button size="xs" fz={15} variant="light" color="blue" onClick={() => startResubmit(ta)}>
                                            Submit with new info
                                        </Button>
                                    </>
                                )}
                                {changePending ? (
                                    <Button size="xs" fz={15} variant="subtle" color="red" onClick={() => act(ta.id, "withdraw", { scope: "change" })}>
                                        Cancel change request
                                    </Button>
                                ) : (liveApproval || latestPending) ? (
                                    <Button size="xs" fz={15} variant="subtle" color="red" onClick={() => act(ta.id, "withdraw")}>
                                        Withdraw
                                    </Button>
                                ) : null}
                                {!liveApproval && latest?.status === "REVOKED" && (
                                    <Button size="xs" fz={15} variant="subtle" color="red" onClick={() => confirmDelete(ta)}>
                                        Delete
                                    </Button>
                                )}
                            </Group>
                        </Group>
                    </Card>
                );
            })}

            <Modal opened={opened} onClose={closeModal} title={resubmitId ? "Resubmit with updated info" : "Add a trusted adult"} size="lg">
                <Stack>
                    {resubmitId && (
                        <Text size="sm" c="dimmed">
                            This goes to the board as a changed record. Any current approval stays in
                            effect for the front desk until the board reviews these changes.
                        </Text>
                    )}
                    <TextInput
                        label="Trusted adult's name"
                        value={trustedAdultName}
                        onChange={(e) => setTrustedAdultName(e.currentTarget.value)}
                        error={nameError}
                        required
                    />
                    <Text c="blue" fw={600} size="sm">
                        Phone or email is required — at least one.
                    </Text>
                    <TextInput
                        label="Their phone"
                        type="tel"
                        value={trustedAdultPhone}
                        onChange={(e) => setTrustedAdultPhone(e.currentTarget.value)}
                        error={phoneError}
                    />
                    <TextInput
                        label="Their email"
                        type="email"
                        value={trustedAdultEmail}
                        onChange={(e) => setTrustedAdultEmail(e.currentTarget.value)}
                        error={emailError}
                    />
                    <Textarea
                        label="For the board: your relationship to this adult, and any limits on it"
                        description="Seen only by the board and your household. Naming a trusted adult creates a Dual Relationship — it lets them have one-on-one contact with your Youth, message them privately, and transport them, without the usual Observable-and-Interruptible, open-communication, and travel rules defined in Treehouse policy. Tell us your relationship to them. If you want to narrow that scope — e.g. no transport, no private messaging, supervised only, or custody/contact restrictions — state it here."
                        minRows={4}
                        autosize
                        value={familyContext}
                        onChange={(e) => setFamilyContext(e.currentTarget.value)}
                        error={contextError}
                        required
                    />
                    {error && <Text c="red" size="sm">{error}</Text>}
                    <Group justify="flex-end">
                        <Button variant="default" onClick={closeModal}>Cancel</Button>
                        <Button
                            onClick={() => {
                                setAttempted(true);
                                if (!trustedAdultName.trim() || contactInvalid || !familyContext.trim()) return;
                                submit();
                            }}
                            loading={submitting}
                        >
                            {resubmitId ? "Resubmit for board review" : "Submit for board review"}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
}
