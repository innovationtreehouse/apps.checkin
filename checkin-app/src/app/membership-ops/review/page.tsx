"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Alert, Button, Card, Checkbox, Container, Group, Radio, Stack, Text, Textarea, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { LoadError } from "@checkin/component-ui";
import { modals } from "@mantine/modals";
import { type AlertTone } from "@/components/admin/AlertBanner";
import { useLoad } from "@/lib/api";
import { notifyNavRefresh } from "@/lib/nav-refresh";

import { PageLoader } from "@/components/ui/PageLoader";
interface Person {
    id: number;
    name: string | null;
    email: string | null;
}
// Shape returned by GET /api/membership/reviews (security-stripped model rows).
// Every item is a check review. One with a person returns them (name + household);
// one a household asked for also returns that household and its leads, the people
// its first reviewer names from. Children are never sent.
interface QueueItem {
  id: number;
  subjectPerson: { id: number; name: string | null; householdId: number | null; household: { name: string | null } | null } | null;
  requestedForHousehold: { name: string | null; intakeNotes: string | null; householdMembers: Person[] } | null;
  _count: { attestations: number };
}

export default function MembershipReviewPage() {
  const { data: session, status: sessionStatus } = useSession();
  const canReset = !!session?.user?.isBoardMember;
  // No h1 here: this page always renders inside the Membership Ops layout, whose
  // tab bar already labels it.
  const { data, error: loadError, status: loadStatus, reload } = useLoad<{ queue?: QueueItem[] }>(
    sessionStatus === "authenticated" ? "/api/membership/reviews" : null,
  );
  const queue = data?.queue ?? [];
  const [busyId, setBusyId] = useState<number | null>(null);
  const [volunteer, setVolunteer] = useState<Record<number, boolean>>({});
  const [reviewNotes, setReviewNotes] = useState<Record<number, string>>({});
  // processId -> the lead this reviewer picked on a review that names nobody yet.
  const [subjects, setSubjects] = useState<Record<number, number>>({});
  // Tagged with the acting row's processId so the result renders in that card, not off-screen at page top.
  const [message, setMessage] = useState<{ processId: number; text: string; tone: AlertTone } | undefined>();
  const [showMine, setShowMine] = useState(false);
  // Reviews this reviewer already approved that have not cleared.
  const { data: mineAnswer, error: mineError, reload: reloadMine } = useLoad<{ queue?: QueueItem[] }>(showMine ? "/api/membership/reviews?mine=1" : null);
  const mine = mineAnswer?.queue ?? [];
  const [showRejected, setShowRejected] = useState(false);
  // Blocked reviews whose rejection is this reviewer's.
  const { data: rejectedAnswer, error: rejectedError, reload: reloadRejected } = useLoad<{ queue?: QueueItem[] }>(showRejected ? "/api/membership/reviews?rejected=1" : null);
  const rejected = rejectedAnswer?.queue ?? [];

  const changeToApprove = async (processId: number) => {
    setBusyId(processId);
    try {
      const res = await fetch("/api/membership/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId, result: "APPROVE" }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notifications.show({ message: "Your answer is now an approval. The review needs one more reviewer to clear." });
        notifyNavRefresh();
      } else {
        notifications.show({ color: "red", message: data.error || "Could not change your answer.", autoClose: false });
      }
      reload();
      reloadRejected();
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setBusyId(null);
    }
  };

  // Changing a rejection starts the review over: every earlier decision is discarded
  // and this approval is the first of the two it needs again.
  const confirmChangeToApprove = (item: QueueItem) =>
    modals.openConfirmModal({
      title: "Change your rejection to an approval?",
      children: (
        <Text size="sm">
          This discards every decision recorded on <strong>{applicantLabel(item)}</strong>&apos;s review,
          your rejection included, and records your approval as the first of two. Another
          independent reviewer must still approve before the check clears.
        </Text>
      ),
      labels: { confirm: "Change to approve", cancel: "Cancel" },
      confirmProps: { color: "orange" },
      onConfirm: () => changeToApprove(item.id),
    });

  const resetReview = async (processId: number, reason: string, wrongPerson: boolean) => {
    setBusyId(processId);
    try {
      const res = await fetch("/api/membership-ops/applications/review-override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId, action: "reset", reason, wrongPerson }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notifications.show({ message: "Review started over — reviewers have been notified." });
        // A repeated reset passes the server's check once the review is open, so the row stays busy until it re-reads.
        await Promise.all([reload(), reloadMine()]);
        notifyNavRefresh();
      } else {
        notifications.show({ color: "red", message: data.error || "Could not reset this review.", autoClose: false });
        reloadMine();
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setBusyId(null);
    }
  };

  const confirmReset = (item: QueueItem) => {
    let reason = "";
    let wrongPerson = false;
    const modalId = modals.openConfirmModal({
      title: "Start this background-check review over?",
      children: (
        <Stack gap="xs">
          <Text size="sm">
            This discards all {item._count.attestations} approval(s) recorded for{" "}
            <strong>{applicantLabel(item)}</strong> — yours included — and asks the reviewers to start
            again. The check has not cleared, so nothing else changes.
          </Text>
          <Textarea label="Reason" required autosize minRows={2} onChange={(e) => { reason = e.currentTarget.value; }} />
          {item.requestedForHousehold && item.subjectPerson && (
            <Checkbox
              label="The review names the wrong person — the next reviewer names again"
              onChange={(e) => { wrongPerson = e.currentTarget.checked; }}
            />
          )}
        </Stack>
      ),
      labels: { confirm: "Start over", cancel: "Cancel" },
      confirmProps: { color: "orange" },
      closeOnConfirm: false,
      onConfirm: () => {
        if (!reason.trim()) {
          notifications.show({ color: "red", message: "A reason is required to start a review over.", autoClose: false });
          return;
        }
        modals.close(modalId);
        resetReview(item.id, reason.trim(), wrongPerson);
      },
    });
  };

  const undoApproval = async (processId: number, reason: string) => {
    setBusyId(processId);
    try {
      const res = await fetch("/api/membership/reviews/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId, reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notifications.show({ message: "Your approval was withdrawn. The review is waiting for reviewers again." });
        notifyNavRefresh();
      } else {
        notifications.show({ color: "red", message: data.error || "Could not undo your approval.", autoClose: false });
      }
      reload();
      reloadMine();
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setBusyId(null);
    }
  };

  const confirmUndo = (item: QueueItem) => {
    let reason = "";
    const modalId = modals.openConfirmModal({
      title: "Undo your approval?",
      children: (
        <Stack gap="xs">
          <Text size="sm">
            This withdraws your approval of <strong>{applicantLabel(item)}</strong>. The review goes back
            to waiting for two approvals. The person it names stays named.
          </Text>
          <Textarea label="Reason" required autosize minRows={2} onChange={(e) => { reason = e.currentTarget.value; }} />
        </Stack>
      ),
      labels: { confirm: "Undo my approval", cancel: "Cancel" },
      confirmProps: { color: "orange" },
      closeOnConfirm: false,
      onConfirm: () => {
        if (!reason.trim()) {
          notifications.show({ color: "red", message: "A reason is required to undo an approval.", autoClose: false });
          return;
        }
        modals.close(modalId);
        undoApproval(item.id, reason.trim());
      },
    });
  };

  const submit = async (processId: number, result: "APPROVE" | "REJECT") => {
    if (result === "REJECT" && !reviewNotes[processId]?.trim()) return;
    setBusyId(processId);
    setMessage(undefined);
    try {
      const res = await fetch("/api/membership/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId, result, isMarkedVolunteerFamily: !!volunteer[processId], note: reviewNotes[processId]?.trim() || undefined, subjectPersonIds: subjectIdsFor(processId) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notifications.show({ message: result === "APPROVE" ? "Attestation recorded — thank you." : "Recorded. The board has been notified." });
        setSubjects((s) => { const next = { ...s }; delete next[processId]; return next; });
        reload();
        notifyNavRefresh();
      } else if (data.code === "already_attested") {
        notifications.show({ color: "red", message: data.error || "Already attested.", autoClose: false });
        reload();
      } else {
        setMessage({ processId, text: data.error || "Could not record your attestation.", tone: "error" });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setBusyId(null);
    }
  };

  // Who this review is about — its person, else the household that asked for it.
  const applicantLabel = (item: QueueItem) =>
    item.subjectPerson
      ? item.subjectPerson.name || `Person #${item.subjectPerson.id}`
      : item.requestedForHousehold?.name || `Household (review #${item.id})`;

  // A queue review only ever holds approvals.
  const approvalsSoFar = (item: QueueItem) => item._count.attestations;

  // The person this reviewer is deciding on — the named one, else the lead they picked.
  const chosenSubject = (item: QueueItem) => item.subjectPerson?.id ?? subjects[item.id] ?? null;

  const pickSubject = (processId: number, personId: number) =>
    setSubjects((s) => ({ ...s, [processId]: personId }));

  // A review with no person yet takes the picked lead on approve and reject alike.
  const subjectIdsFor = (processId: number) => {
    const item = queue.find((q) => q.id === processId);
    const picked = item && !item.subjectPerson ? subjects[processId] : undefined;
    return picked === undefined ? [] : [picked];
  };

  const personName = (item: QueueItem, personId: number) => {
    if (item.subjectPerson?.id === personId) return item.subjectPerson.name || `Person #${personId}`;
    const p = (item.requestedForHousehold?.householdMembers ?? []).find((m) => m.id === personId);
    return p?.name || p?.email || `Person #${personId}`;
  };

  // Attesting is a one-click, two-of-two decision, and the SECOND approval
  // completes the clearance — stamping the named adult, opening payment or activating, and
  // emailing the family. Confirm both actions, and say what the click actually does
  // rather than "are you sure?", which trains people to click through.
  const confirmSubmit = (item: QueueItem, result: "APPROVE" | "REJECT") => {
    const who = applicantLabel(item);
    // Either kind clears on its second counted approval.
    const clearing = result === "APPROVE" && approvalsSoFar(item) >= 1;
    modals.openConfirmModal({
      title: result === "REJECT" ? "Reject this background check?" : clearing ? "Approve the background check clearance?" : "Record your attestation?",
      children: (
        <Text size="sm">
          {result === "REJECT" ? (
            <>
              This records a rejection of {personName(item, chosenSubject(item)!)}&apos;s background check,
              which holds <strong>{who}</strong>&apos;s membership and notifies the board. The
              applicant is not told the reason.
            </>
          ) : clearing ? (
            <>
              You are the second reviewer for <strong>{who}</strong>. Attesting completes the clearance and
              records it against {personName(item, chosenSubject(item)!)}. If their household is waiting
              on this check, payment opens (or the membership activates if the fee is already paid) and the
              family is emailed. It cannot be undone.
            </>
          ) : (
            <>
              This records your approval of {personName(item, chosenSubject(item)!)}&apos;s background check.
              A second reviewer must also approve the same person before the clearance completes.
            </>
          )}
        </Text>
      ),
      labels: { confirm: result === "REJECT" ? "Reject" : clearing ? "Attest — approve the clearance" : "Attest", cancel: "Cancel" },
      confirmProps: { color: result === "REJECT" ? "red" : clearing ? "orange" : undefined },
      onConfirm: () => submit(item.id, result),
    });
  };

  if (sessionStatus === "loading" || (sessionStatus === "authenticated" && data === null && !loadError && loadStatus !== 403)) {
    return <PageLoader />;
  }

  if (loadStatus === 403 || sessionStatus === "unauthenticated") {
    return (
      <Container size="xs" py="xl">
        <Card withBorder radius="md" padding="xl" ta="center">
          <Title order={2}>Background-check review</Title>
          <Text c="dimmed" my="md">This area is for background-check reviewers only.</Text>
        </Card>
      </Container>
    );
  }

  return (
    <Container size="md" pb="md">
      <Text c="dimmed">
        Review each background check on Averity, then decide below. A review covers one adult. When a
        household asked for the check, the first reviewer names the person whose report they read, on
        an approval or a rejection, and the check is recorded against them and nobody else. Two
        independent reviewers must approve. If anything is concerning, choose <strong>Reject</strong> —
        the board is notified and the applicant is not told the reason. If the named person is wrong,
        ask the board to start the review over.
      </Text>

      <Checkbox
        mt="md"
        checked={showMine}
        onChange={(e) => setShowMine(e.currentTarget.checked)}
        label="Show incomplete reviews I've already approved"
      />

      <Checkbox
        mt="xs"
        checked={showRejected}
        onChange={(e) => setShowRejected(e.currentTarget.checked)}
        label="Show blocked reviews I rejected"
      />

      {showRejected && (
        <Stack mt="md">
          {rejectedError && <LoadError what="the reviews you rejected" message={rejectedError} onRetry={reloadRejected} />}
          {rejectedAnswer === null ? null : rejected.length === 0 ? (
            <Text size="sm" c="dimmed">None — no blocked review carries your rejection.</Text>
          ) : rejected.map((item) => (
            <Card key={item.id} withBorder radius="md" padding="lg" bg="var(--mantine-color-gray-0)">
              <Text fw={700}>{applicantLabel(item)}</Text>
              <Text size="xs" c="dimmed" mt={4}>You rejected this, so it is blocked.</Text>
              <Group mt="sm">
                <Button size="xs" variant="default" loading={busyId === item.id} onClick={() => confirmChangeToApprove(item)}>
                  Change to approve
                </Button>
              </Group>
            </Card>
          ))}
        </Stack>
      )}

      {showMine && (
        <Stack mt="md">
          {mineError && <LoadError what="the reviews you approved" message={mineError} onRetry={reloadMine} />}
          {mineAnswer === null ? null : mine.length === 0 ? (
            <Text size="sm" c="dimmed">None — every review you approved has cleared.</Text>
          ) : mine.map((item) => (
            <Card key={item.id} withBorder radius="md" padding="lg" bg="var(--mantine-color-gray-0)">
              <Text fw={700}>{applicantLabel(item)}</Text>
              <Text size="xs" c="dimmed" mt={4}>
                You approved this. {approvalsSoFar(item)}/2 approvals so far.
              </Text>
              <Group mt="sm">
                <Button size="xs" variant="default" loading={busyId === item.id} onClick={() => confirmUndo(item)}>
                  Undo my approval
                </Button>
                {canReset ? (
                  <Button size="xs" variant="default" loading={busyId === item.id} onClick={() => confirmReset(item)}>
                    Start review over
                  </Button>
                ) : (
                  <Text size="xs" c="dimmed">A board member can start this review over.</Text>
                )}
              </Group>
            </Card>
          ))}
        </Stack>
      )}

      {loadError && <Stack mt="md"><LoadError what="the review queue" message={loadError} onRetry={reload} /></Stack>}

      {data === null ? null : queue.length === 0 ? (
        <Card withBorder radius="md" padding="xl" ta="center" mt="md">
          <Text c="dimmed">Nothing awaiting your review right now.</Text>
        </Card>
      ) : (
        <Stack mt="md">
          {queue.map((item) => {
            const subject = item.subjectPerson;
            const requested = item.requestedForHousehold;
            const leads = requested?.householdMembers ?? [];
            const notes = requested?.intakeNotes?.trim();
            return (
            <Card key={item.id} withBorder radius="md" padding="lg">
              <Text fw={700} fz="lg">{applicantLabel(item)}</Text>
              <Text size="sm" c="dimmed" mt={4}>
                {subject
                  ? `Background check for ${subject.name || `Person #${subject.id}`} · ${subject.household?.name ? `Household: ${subject.household.name}` : "No household on file"}`
                  : leads.length > 0
                    ? leads.map((p) => `${p.name || "—"}${p.email ? ` <${p.email}>` : ""}`).join(", ")
                    : "No household lead on file."}
              </Text>
              <Text size="xs" c="dimmed" mt={4}>{approvalsSoFar(item)}/2 approvals so far.</Text>

              {/* Whose report did you read? A review a household asked for names nobody
                  until its first decision, approve or reject; the server refuses one
                  without a name. Once named, a later reviewer decides on that person. */}
              {!subject && (
                <Stack gap={4} mt="md">
                  {leads.length === 0 ? (
                    <Text size="sm" c="dimmed">No household leads on file — this review cannot be decided.</Text>
                  ) : (
                    <Radio.Group
                      label="Whose check did you review?"
                      description="One adult. A second adult's own check is tracked separately."
                      value={String(subjects[item.id] ?? "")}
                      onChange={(v) => pickSubject(item.id, Number(v))}
                    >
                      <Stack gap={4} mt={4}>
                        {leads.map((p) => (
                          <Radio key={p.id} value={String(p.id)} label={p.name || p.email || `Person #${p.id}`} />
                        ))}
                      </Stack>
                    </Radio.Group>
                  )}
                </Stack>
              )}

              {/* The intake note and the volunteer-only mark belong to the household that asked for the check. */}
              {requested && notes && (
                <Alert color="yellow" variant="light" mt="md" title="From the applicant — “Anything else we should know?”">
                  <Text style={{ whiteSpace: "pre-wrap" }}>{notes}</Text>
                </Alert>
              )}

              {requested && (
                <Checkbox
                  my="md"
                  checked={!!volunteer[item.id]}
                  onChange={(e) => { const checked = e.currentTarget.checked; setVolunteer((v) => ({ ...v, [item.id]: checked })); }}
                  label="This is a volunteer only family (no students)"
                />
              )}

              <Textarea
                mt="md"
                label="Notes"
                placeholder="Optional for approval, required for rejection"
                value={reviewNotes[item.id] ?? ""}
                onChange={(e) => { const value = e.currentTarget.value; setReviewNotes((n) => ({ ...n, [item.id]: value })); }}
                autosize
                minRows={2}
              />

              <Group gap="sm" wrap="wrap" mt="md">
                <Button
                  disabled={busyId === item.id || (!subject && chosenSubject(item) === null)}
                  loading={busyId === item.id}
                  onClick={() => confirmSubmit(item, "APPROVE")}
                >
                  Attest — approve this person
                </Button>
                <Button color="red" variant="light" disabled={busyId === item.id || !reviewNotes[item.id]?.trim() || chosenSubject(item) === null} onClick={() => confirmSubmit(item, "REJECT")}>
                  Reject
                </Button>
              </Group>

              {message?.processId === item.id && (
                <Alert color={message.tone === "success" ? "treehouseGreen" : "red"} variant="light" mt="md">
                  {message.text}
                </Alert>
              )}
            </Card>
            );
          })}
        </Stack>
      )}
    </Container>
  );
}
