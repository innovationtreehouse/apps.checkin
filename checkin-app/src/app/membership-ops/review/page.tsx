"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { Alert, Button, Card, Checkbox, Container, Group, Radio, Stack, Text, Textarea, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { modals } from "@mantine/modals";
import { type AlertTone } from "@/components/admin/AlertBanner";
import { notifyNavRefresh } from "@/lib/nav-refresh";
import { clearingApprovals, establishedSubject } from "@/lib/membership/approvals";

import { PageLoader } from "@/components/ui/PageLoader";
interface Person {
    id: number;
    name: string | null;
    email: string | null;
}
// Shape returned by GET /api/membership/reviews (security-stripped model rows).
// A household review returns the leads (parents); a PERSON_BG review returns the
// subject person (name + household context) instead. Children are never sent.
interface QueueItem {
  id: number;
  subjectPerson: { id: number; name: string | null; householdId: number | null; household: { name: string | null } | null } | null;
  orgMembership: { household: { name: string | null; intakeNotes: string | null; householdMembers: Person[] } | null } | null;
  // Subject ids only — enough to count approvals per lead, and it says nothing
  // about WHO approved (see the route comment).
  attestations: { subjectPersonId: number | null }[];
  _count: { attestations: number };
}

export default function MembershipReviewPage() {
  const { data: session, status: sessionStatus } = useSession();
  const canReset = !!(session?.user?.isBoardMember || session?.user?.isSysadmin);
  // No h1 here: this page always renders inside the Membership Ops layout, whose
  // tab bar already labels it (the standalone /membership/review route is gone).
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [volunteer, setVolunteer] = useState<Record<number, boolean>>({});
  const [reviewNotes, setReviewNotes] = useState<Record<number, string>>({});
  // processId -> the lead this reviewer picked, before anyone has settled the subject.
  const [subjects, setSubjects] = useState<Record<number, number>>({});
  // Tagged with the acting row's processId so the result renders in that card, not off-screen at page top.
  const [message, setMessage] = useState<{ processId: number; text: string; tone: AlertTone } | undefined>();
  const [showMine, setShowMine] = useState(false);
  // Reviews this reviewer already approved that have not cleared.
  const [mine, setMine] = useState<QueueItem[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/membership/reviews");
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setQueue(data.queue || []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMine = useCallback(async () => {
    const res = await fetch("/api/membership/reviews?mine=1");
    if (res.ok) setMine((await res.json()).queue || []);
  }, []);

  useEffect(() => {
    if (sessionStatus === "authenticated") load();
    else if (sessionStatus === "unauthenticated") setLoading(false);
  }, [sessionStatus, load]);

  useEffect(() => {
    if (showMine) loadMine();
  }, [showMine, loadMine]);

  const resetReview = async (processId: number) => {
    setBusyId(processId);
    try {
      const res = await fetch("/api/membership-ops/applications/review-override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId, action: "reset" }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notifications.show({ message: "Review started over — reviewers have been notified." });
        await Promise.all([load(), loadMine()]);
        notifyNavRefresh();
      } else {
        notifications.show({ color: "red", message: data.error || "Could not reset this review.", autoClose: 4000 });
        await loadMine();
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setBusyId(null);
    }
  };

  const confirmReset = (item: QueueItem) =>
    modals.openConfirmModal({
      title: "Start this background-check review over?",
      children: (
        <Text size="sm">
          This discards all {item._count.attestations} approval(s) recorded for{" "}
          <strong>{applicantLabel(item)}</strong> — yours included — and asks the reviewers to start
          again. The check has not cleared, so nothing else changes.
        </Text>
      ),
      labels: { confirm: "Start over", cancel: "Cancel" },
      confirmProps: { color: "orange" },
      onConfirm: () => resetReview(item.id),
    });

  const submit = async (processId: number, result: "APPROVE" | "REJECT") => {
    if (result === "REJECT" && !reviewNotes[processId]?.trim()) return;
    setBusyId(processId);
    setMessage(undefined);
    try {
      const res = await fetch("/api/membership/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId, result, isMarkedVolunteer: !!volunteer[processId], note: reviewNotes[processId]?.trim() || undefined, subjectPersonIds: subjectIdsFor(processId) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notifications.show({ message: result === "APPROVE" ? "Attestation recorded — thank you." : "Recorded. The board has been notified." });
        setSubjects((s) => { const next = { ...s }; delete next[processId]; return next; });
        await load();
        notifyNavRefresh();
      } else if (data.code === "already_attested") {
        notifications.show({ color: "red", message: data.error || "Already attested.", autoClose: 4000 });
        await load();
      } else {
        setMessage({ processId, text: data.error || "Could not record your attestation.", tone: "error" });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setBusyId(null);
    }
  };

  // Who this review is about — the PERSON_BG subject, else the applicant household.
  const applicantLabel = (item: QueueItem) =>
    item.subjectPerson
      ? item.subjectPerson.name || `Person #${item.subjectPerson.id}`
      : item.orgMembership?.household?.name || `Household (application #${item.id})`;

  // Who this review is about, once someone has approved. A review covers ONE adult:
  // the first approval fixes the subject, so a later reviewer confirms that person
  // rather than choosing again.
  const settledSubject = (item: QueueItem) => establishedSubject(item.attestations);

  // Approvals that count toward clearing — a household's unnamed or other-adult
  // approvals are recorded but don't, so this can sit below the attestation count.
  const approvalsSoFar = (item: QueueItem) => clearingApprovals(item.attestations, !!item.subjectPerson);

  // The subject this reviewer is about to attest — the settled one if there is one,
  // else whichever lead they picked.
  const chosenSubject = (item: QueueItem) => settledSubject(item) ?? subjects[item.id] ?? null;

  const pickSubject = (processId: number, personId: number) =>
    setSubjects((s) => ({ ...s, [processId]: personId }));

  // The wire carries a list; a household review names exactly one adult, and a
  // PERSON_BG or a rejection names nobody.
  const subjectIdsFor = (processId: number) => {
    const item = queue.find((q) => q.id === processId);
    const chosen = item && !item.subjectPerson ? chosenSubject(item) : null;
    return chosen === null ? [] : [chosen];
  };

  const leadName = (item: QueueItem, personId: number) => {
    const p = (item.orgMembership?.household?.householdMembers ?? []).find((m) => m.id === personId);
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
              This blocks <strong>{who}</strong>&apos;s membership and notifies the board. The
              applicant is not told the reason.
            </>
          ) : clearing ? (
            <>
              You are the second reviewer for <strong>{who}</strong>. Attesting completes the clearance,
              records it against {item.subjectPerson ? "the subject" : leadName(item, chosenSubject(item)!)},
              opens payment (or activates the membership if the fee is already paid), and emails the
              family. It cannot be undone.
            </>
          ) : (
            <>
              This records your approval of <strong>{who}</strong>&apos;s background check
              {item.subjectPerson ? "" : ` for ${leadName(item, chosenSubject(item)!)}`}. A second
              reviewer must also approve the same person before the clearance completes.
            </>
          )}
        </Text>
      ),
      labels: { confirm: result === "REJECT" ? "Reject" : clearing ? "Attest — approve the clearance" : "Attest", cancel: "Cancel" },
      confirmProps: { color: result === "REJECT" ? "red" : clearing ? "orange" : undefined },
      onConfirm: () => submit(item.id, result),
    });
  };

  if (sessionStatus === "loading" || loading) {
    return <PageLoader />;
  }

  if (forbidden || sessionStatus === "unauthenticated") {
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
        Review each applicant&apos;s background check on Averity, then attest below. A review covers
        one adult — name the person whose report you read, and the check is recorded against them and
        nobody else. Two independent reviewers must approve the same person. If anything is
        concerning, choose <strong>Reject</strong> — the board is notified and the applicant is not
        told the reason.
      </Text>

      <Checkbox
        mt="md"
        checked={showMine}
        onChange={(e) => setShowMine(e.currentTarget.checked)}
        label="Show incomplete reviews I've already approved"
      />

      {showMine && (
        <Stack mt="md">
          {mine.length === 0 ? (
            <Text size="sm" c="dimmed">None — every review you approved has cleared.</Text>
          ) : mine.map((item) => {
            const settled = settledSubject(item);
            // Only a household review names its subject; an unnamed approval there counts toward nobody.
            const unnamed = !item.subjectPerson && item.attestations.some((a) => a.subjectPersonId === null);
            return (
              <Card key={item.id} withBorder radius="md" padding="lg" bg="var(--mantine-color-gray-0)">
                <Text fw={700}>{applicantLabel(item)}</Text>
                <Text size="xs" c="dimmed" mt={4}>
                  You approved this. {approvalsSoFar(item)}/2 approvals so far
                  {settled !== null ? ` · for ${leadName(item, settled)}` : ""}.
                </Text>
                {unnamed && (
                  <Text size="sm" c="orange" mt={4}>
                    An approval here names nobody, so it can never count toward clearance. Start the review over.
                  </Text>
                )}
                {canReset ? (
                  <Group mt="sm">
                    <Button size="xs" variant="default" loading={busyId === item.id} onClick={() => confirmReset(item)}>
                      Start review over
                    </Button>
                  </Group>
                ) : (
                  <Text size="xs" c="dimmed" mt="sm">A board member can start this review over.</Text>
                )}
              </Card>
            );
          })}
        </Stack>
      )}

      {queue.length === 0 ? (
        <Card withBorder radius="md" padding="xl" ta="center" mt="md">
          <Text c="dimmed">Nothing awaiting your review right now.</Text>
        </Card>
      ) : (
        <Stack mt="md">
          {queue.map((item) => {
            const subject = item.subjectPerson;
            const parents = item.orgMembership?.household?.householdMembers ?? [];
            const notes = item.orgMembership?.household?.intakeNotes?.trim();
            return (
            <Card key={item.id} withBorder radius="md" padding="lg">
              {subject ? (
                <>
                  <Text fw={700} fz="lg">{applicantLabel(item)}</Text>
                  <Text size="sm" c="dimmed" mt={4}>
                    Background check for an individual · {subject.household?.name ? `Household: ${subject.household.name}` : "No household on file"}
                  </Text>
                </>
              ) : (
                <>
                  <Text fw={700} fz="lg">{applicantLabel(item)}</Text>
                  <Text size="sm" c="dimmed" mt={4}>
                    {parents.length > 0
                      ? parents.map((p) => `${p.name || "—"}${p.email ? ` <${p.email}>` : ""}`).join(", ")
                      : "No parent contact on file."}
                  </Text>
                </>
              )}
              <Text size="xs" c="dimmed" mt={4}>{approvalsSoFar(item)}/2 approvals so far.</Text>

              {/* Whose report did you read? The Averity report names its subject, and
                  that name is the only record of who a household's check covered — so
                  approving without one is refused by the server. Once someone has
                  approved, the subject is settled and a later reviewer confirms that
                  person; disagreeing means rejecting, not naming someone else. */}
              {!subject && (
                <Stack gap={4} mt="md">
                  {settledSubject(item) !== null ? (
                    <>
                      <Text size="sm" fw={600}>This review is for {leadName(item, settledSubject(item)!)}</Text>
                      <Text size="sm" c="dimmed">
                        Named by the first reviewer. Approve only if the report you read is theirs —
                        if it names someone else, reject so the board can sort it out.
                      </Text>
                    </>
                  ) : parents.length === 0 ? (
                    <Text size="sm" c="dimmed">No household leads on file — this application cannot be attested.</Text>
                  ) : (
                    <Radio.Group
                      label="Whose check did you review?"
                      description="One adult. A second adult's own check is tracked separately."
                      value={String(subjects[item.id] ?? "")}
                      onChange={(v) => pickSubject(item.id, Number(v))}
                    >
                      <Stack gap={4} mt={4}>
                        {parents.map((p) => (
                          <Radio key={p.id} value={String(p.id)} label={p.name || p.email || `Person #${p.id}`} />
                        ))}
                      </Stack>
                    </Radio.Group>
                  )}
                </Stack>
              )}

              {/* Household-application concepts (intake note + volunteer-only mark)
                  don't apply to a per-person BG check. */}
              {!subject && notes && (
                <Alert color="yellow" variant="light" mt="md" title="From the applicant — “Anything else we should know?”">
                  <Text style={{ whiteSpace: "pre-wrap" }}>{notes}</Text>
                </Alert>
              )}

              {!subject && (
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
                <Button color="red" variant="light" disabled={busyId === item.id || !reviewNotes[item.id]?.trim()} onClick={() => confirmSubmit(item, "REJECT")}>
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
