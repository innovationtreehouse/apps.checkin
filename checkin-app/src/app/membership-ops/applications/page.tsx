"use client";

import { useRef, useState, Suspense } from "react";
import { Alert, Button, Card, Center, Group, Loader, Modal, Select, Stack, Switch, Text, Textarea } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { clearError, errorMessage, HttpError, LoadError, showError, showSuccess, showWarning } from "@checkin/component-ui";
import { modals } from "@mantine/modals";
import { useSession } from "next-auth/react";
import { api, useLoad } from "@/lib/api";
import { notifyNavRefresh } from "@/lib/nav-refresh";
import { sharesHousehold } from "@/lib/conflictOfInterest";
import { PageLoader } from "@/components/ui/PageLoader";
import { ReasonConfirm } from "@/components/ReasonConfirm";
import { StatusFilterBadge, ActiveFilterNotice, useStatusFilter } from "@/components/StatusFilter";
import { reopenYearRefusal } from "@/lib/programYear";
import { useMembershipYearBoundary } from "@/app/program-ops/ProgramYearField";
import { CLOSABLE_STATUSES, awaitingBgReview, refundableApplication, type ProcessKind, type ProcessStatus } from "@/lib/membership/lifecycle";

interface Person {
  id: number;
  name: string | null;
  email: string | null;
  isHouseholdLead: boolean;
}
interface Attestation {
  id: number;
  result: string;
  subjectPersonId: number | null;
  isMarkedVolunteerFamily: boolean;
}
interface ProcessRow {
  id: number;
  kind: string;
  status: string;
  createdAt: string;
  zohoEnvelopeId: string | null;
  contractSignedAt: string | null;
  bgConsentAt: string | null;
  bgClearedAt: string | null;
  paidAt: string | null;
  attestations: Attestation[];
  requestedForHouseholdId: number | null;
  subjectPerson: { id: number; name: string | null; householdId: number | null } | null;
  orgMembership: {
    householdId: number;
    isVolunteerFamily: boolean;
    household: { name: string | null; householdMembers: Person[] } | null;
  } | null;
  // A renewal for the year its household has said it won't renew into.
  notRenewing: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  INTAKE: "gray",
  PENDING_EXTERNAL_ACTION: "blue",
  PENDING_BG_REVIEW: "grape",
  PENDING_PAYMENT: "orange",
  PENDING_BG_CLEARANCE: "grape",
  BLOCKED: "red",
  PENDING_RENEWAL: "teal",
  RENEWAL_PENDING_BG: "grape",
};

const KIND_LABELS: Record<string, string> = {
  INITIAL: "New membership",
  RENEWAL: "Renewal",
  PERSON_AGREEMENT: "Membership agreement",
  PERSON_BG: "Background check",
  KEY_VOLUNTEER_AGREEMENT: "Key Volunteer agreement",
};

const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

const statusColor = (status: string) => STATUS_COLORS[status] || "gray";
// The "Not renewing" tag filters through the status filter's param, under a value no status takes.
const NOT_RENEWING = "not-renewing";
const statusLabel = (status: string) =>
  status === NOT_RENEWING ? "Not renewing" : status === "ARCHIVED" ? "CLOSED" : status.replace(/_/g, " ");

// A check review in the reviewer queue. ONE definition, shared with the server:
// awaitingBgReview.has — client-safe (booleans in, no Prisma).
const awaitingBg = (r: ProcessRow) =>
  awaitingBgReview.has({ kind: r.kind as ProcessKind, status: r.status as ProcessStatus, bgConsentAt: !!r.bgConsentAt, bgClearedAt: !!r.bgClearedAt });

const leadsOf = (r: ProcessRow) => (r.orgMembership?.household?.householdMembers ?? []).filter((p) => p.isHouseholdLead);

// The body of the mark-check-started dialog: confirming with no lead picked flags the Lead field.
function LeadPickConfirm({ leads, onCancel, onConfirm }: {
  leads: Person[];
  onCancel: () => void;
  onConfirm: (personId: number) => void;
}) {
  const [personId, setPersonId] = useState<string | null>(leads.length === 1 ? String(leads[0].id) : null);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const confirm = () => {
    if (personId === null) {
      setError("Pick a lead.");
      field.current?.focus();
      return;
    }
    onConfirm(Number(personId));
  };
  return (
    <Stack gap="xs">
      <Text size="sm">Pick the lead whose check was started in the background-check tool. Their review goes to the reviewers.</Text>
      <Select
        ref={field}
        label="Lead"
        required
        data={leads.map((p) => ({ value: String(p.id), label: p.name || p.email || `Person #${p.id}` }))}
        value={personId}
        error={error}
        onChange={(v) => { setPersonId(v); setError(null); }}
      />
      <Group justify="flex-end" mt="sm">
        <Button variant="default" onClick={onCancel}>Cancel</Button>
        <Button onClick={confirm}>Mark check started</Button>
      </Group>
    </Stack>
  );
}

// A household's check is started when an open review has a lead's check started, or a
// review it asked for waits to be named, or the application carries the legacy flag.
// Mirrors householdCheckStarted on the server, from rows this page already has.
const householdCheckStarted = (r: ProcessRow, rows: readonly ProcessRow[]) => {
  const householdId = r.orgMembership?.householdId;
  if (householdId === undefined) return false;
  if (r.bgConsentAt) return true;
  const leadIds = new Set(leadsOf(r).map((p) => p.id));
  return rows.some((p) =>
    p.kind === "PERSON_BG" && (p.status === "PENDING_BG_REVIEW" || p.status === "BLOCKED") &&
    ((!!p.bgConsentAt && !!p.subjectPerson && leadIds.has(p.subjectPerson.id)) || (!p.subjectPerson && p.requestedForHouseholdId === householdId)));
};

// A household application with its check started and not cleared waits on its people's check reviews.
const waitingOnCheckReview = (r: ProcessRow, rows: readonly ProcessRow[]) =>
  r.kind !== "PERSON_BG" && !!r.orgMembership && !r.bgClearedAt && r.status !== "BLOCKED" && householdCheckStarted(r, rows);

// Mirror archiveApplication's and recordRefund's gates; the server re-checks.
const closable = (r: ProcessRow) => !r.paidAt && (CLOSABLE_STATUSES as readonly string[]).includes(r.status);
const refundable = (r: ProcessRow) => refundableApplication.has({ status: r.status, paidAt: !!r.paidAt });

export default function AdminMembershipPage() {
  return (
    <Suspense fallback={<PageLoader />}>
      <ApplicationsBoard />
    </Suspense>
  );
}

function ApplicationsBoard() {
  const { data: session } = useSession();
  const me = session?.user;
  // Conflict of interest: no actor may advance/certify/reset their OWN household's
  // application (mirrors the server guards in certifyPaymentPlan, boardResetReview and
  // the EXTERNAL-phase route).
  // The disabled state is UX only — the server is the real enforcement.
  const ownHousehold = (r: ProcessRow) =>
    [r.orgMembership?.householdId, r.subjectPerson?.householdId, r.requestedForHouseholdId].some((h) => sharesHousehold(me?.householdId, h ?? null));
  const [busyId, setBusyId] = useState<number | null>(null);
  const { active, toggle, clear } = useStatusFilter();
  const [certifyOpened, { open: openCertify, close: closeCertify }] = useDisclosure(false);
  const [pendingCertify, setPendingCertify] = useState<number | null>(null);
  const [certifyReason, setCertifyReason] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  // Mirrors the server's same-year Reopen refusal; the server stays the enforcement.
  const { boundary } = useMembershipYearBoundary(showArchived);
  const yearRefusal = (r: ProcessRow) => reopenYearRefusal(r.kind, new Date(r.createdAt), boundary, new Date());
  const [refundOpened, { open: openRefund, close: closeRefund }] = useDisclosure(false);
  const [pendingRefund, setPendingRefund] = useState<number | null>(null);
  const [refundReason, setRefundReason] = useState("");

  const { data, error: loadError, reload } = useLoad<{ processes?: ProcessRow[] }>(
    `/api/membership-ops/applications${showArchived ? "?archived=1" : ""}`,
  );
  const rows = data?.processes ?? [];

  // The row stays busy until the list re-reads, so a second click can't act on a stale row. A 409 means the
  // row changed under the board, so it re-reads too.
  const post = async (processId: number, path: string, body: Record<string, unknown>, done: string) => {
    setBusyId(processId);
    try {
      await api(path.startsWith("/") ? path : `/api/membership-ops/applications/${path}`, { method: "POST", body: JSON.stringify({ processId, ...body }), invalidate: false });
      showSuccess(done);
      notifyNavRefresh();
      await reload();
    } catch (e) {
      // The title names the application, since the message sits away from its row.
      const row = rows.find((r) => r.id === processId);
      showError(errorMessage(e), { key: `application-${processId}`, title: row ? processLabel(row) : `Application #${processId}` });
      if (e instanceof HttpError && e.status === 409) await reload();
    } finally {
      setBusyId(null);
    }
  };

  const act = (processId: number, action: string) => post(processId, "external", { action }, "Updated.");
  const resetReview = (processId: number, reason: string, wrongPerson: boolean) =>
    post(processId, "review-override", { action: "reset", reason, wrongPerson }, "Sent back for re-review.");
  const releaseApplication = (processId: number, reason: string) =>
    post(processId, "review-override", { action: "release", reason }, "Released — the application moves on.");
  const closeWrongPerson = (processId: number, reason: string) =>
    post(processId, "review-override", { action: "reset", reason, closeAsWrongPerson: true }, "Closed as opened for the wrong person.");
  const reopenWrongPerson = (processId: number, reason: string) =>
    post(processId, "review-override", { action: "reopen", reason }, "Check review reopened.");
  const archive = (processId: number) => post(processId, "archive", {}, "Application closed.");
  const markLeadCheckStarted = (processId: number, personId: number) =>
    post(processId, "/api/membership-audit/person-bg", { personId }, "Check marked started.");
  const dismissReview = (processId: number, reason: string) =>
    post(processId, "/api/membership/reviews/dismiss", { reason }, "Dismissed: the check is no longer marked started.");

  const confirmMarkLead = (r: ProcessRow) => {
    const modalId = `mark-lead-${r.id}`;
    modals.open({
      modalId,
      title: "Mark a lead's check started",
      children: (
        <LeadPickConfirm
          leads={leadsOf(r)}
          onCancel={() => modals.close(modalId)}
          onConfirm={(personId) => {
            modals.close(modalId);
            markLeadCheckStarted(r.id, personId);
          }}
        />
      ),
    });
  };

  const confirmDismiss = (r: ProcessRow) => {
    const modalId = `dismiss-${r.id}`;
    modals.open({
      modalId,
      title: "Dismiss: opened by mistake",
      children: (
        <ReasonConfirm
          confirmLabel="Dismiss"
          missingReason="A reason is required to dismiss a check review."
          onCancel={() => modals.close(modalId)}
          onConfirm={(reason) => {
            modals.close(modalId);
            dismissReview(r.id, reason);
          }}
        >
          <Text size="sm">
            This undoes the &quot;check started&quot; mark on <strong>{processLabel(r)}</strong>. It decides nothing:
            no approval, no rejection. Check the background-check tool first.
          </Text>
        </ReasonConfirm>
      ),
    });
  };

  // An awaiting review only ever holds APPROVE attestations (any REJECT blocks it).
  const approvals = (r: ProcessRow) => r.attestations.filter((a) => a.result === "APPROVE").length;

  // Every reset takes a reason. A review a household asked for can also be reset as
  // naming the wrong person, which returns it to no person.
  const confirmResetReview = (r: ProcessRow) => {
    let wrongPerson = false;
    const modalId = `reset-review-${r.id}`;
    modals.open({
      modalId,
      title: "Start this background-check review over?",
      children: (
        <ReasonConfirm
          confirmLabel="Start over"
          missingReason="A reason is required to start a review over."
          onCancel={() => modals.close(modalId)}
          onConfirm={(reason) => {
            modals.close(modalId);
            resetReview(r.id, reason, wrongPerson);
          }}
        >
          <Text size="sm">
            This discards the {r.attestations.length} decision(s) recorded for <strong>{processLabel(r)}</strong>{" "}
            and asks the reviewers to start again. The check itself has not cleared, so nothing else changes.
          </Text>
          {r.kind === "PERSON_BG" && r.requestedForHouseholdId !== null && r.subjectPerson && (
            <Switch
              label="The review names the wrong person — the next reviewer names again"
              onChange={(e) => { wrongPerson = e.currentTarget.checked; }}
            />
          )}
        </ReasonConfirm>
      ),
    });
  };

  // B27: the Board closes a check review opened for the wrong person. Its decisions stay
  // on record, and its rejection stops counting.
  const confirmCloseWrongPerson = (r: ProcessRow) => {
    const modalId = `close-wrong-person-${r.id}`;
    modals.open({
      modalId,
      title: "Close this check review as opened for the wrong person?",
      children: (
        <ReasonConfirm
          confirmLabel="Close review"
          missingReason="A reason is required to close a review as opened for the wrong person."
          onCancel={() => modals.close(modalId)}
          onConfirm={(reason) => {
            modals.close(modalId);
            closeWrongPerson(r.id, reason);
          }}
        >
          <Text size="sm">
            This closes the review of <strong>{processLabel(r)}</strong>. Its {r.attestations.length} decision(s),
            any rejection included, stay on record against it but no longer count against anyone. The Board can reopen it.
          </Text>
        </ReasonConfirm>
      ),
    });
  };

  const confirmReopenWrongPerson = (r: ProcessRow) => {
    const modalId = `reopen-wrong-person-${r.id}`;
    modals.open({
      modalId,
      title: "Reopen this check review?",
      children: (
        <ReasonConfirm
          confirmLabel="Reopen review"
          missingReason="A reason is required to reopen a review."
          onCancel={() => modals.close(modalId)}
          onConfirm={(reason) => {
            modals.close(modalId);
            reopenWrongPerson(r.id, reason);
          }}
        >
          <Text size="sm">
            Only for a review the Board closed as opened for the wrong person. It returns to where it was
            closed, and any rejection on it counts again.
          </Text>
        </ReasonConfirm>
      ),
    });
  };

  const wrongPersonClose = (r: ProcessRow) =>
    me?.isBoardMember && r.kind === "PERSON_BG" && (
      <Button size="xs" fz={15} variant="default" color="red" disabled={busyId === r.id || ownHousehold(r)} onClick={() => confirmCloseWrongPerson(r)}>
        Close: opened for the wrong person
      </Button>
    );

  // A blocked household application with nobody in its household under a blocked check
  // review: whoever's rejection blocked it has left. The server re-checks.
  const releasable = (r: ProcessRow) =>
    r.kind !== "PERSON_BG" && r.status === "BLOCKED" && !!r.orgMembership &&
    !rows.some((p) => p.kind === "PERSON_BG" && p.status === "BLOCKED" && p.subjectPerson?.householdId === r.orgMembership?.householdId);

  const confirmRelease = (r: ProcessRow) => {
    const modalId = `release-${r.id}`;
    modals.open({
      modalId,
      title: "Release this household from a departed person's rejection?",
      children: (
        <ReasonConfirm
          confirmLabel="Release"
          missingReason="A reason is required to release a household."
          onCancel={() => modals.close(modalId)}
          onConfirm={(reason) => {
            modals.close(modalId);
            releaseApplication(r.id, reason);
          }}
        >
          <Text size="sm">
            The person whose check was rejected has left <strong>{processLabel(r)}</strong>. Releasing lets this
            application move on. Their rejection stays on them and still blocks any household they are in.
          </Text>
        </ReasonConfirm>
      ),
    });
  };

  // Closing a long-idle, unpaid application removes it from the board list. Confirm
  // because it's a deliberate cleanup action (kept in the audit log, not deleted).
  const confirmArchive = (r: ProcessRow) => {
    modals.openConfirmModal({
      title: "Close this application?",
      children: (
        <Text size="sm">
          This removes <strong>{processLabel(r)}</strong> (application #{r.id}) from the board list.
          A record is kept in the audit log, and the board can reopen it. Only do this for
          applications that have sat idle and unpaid.
        </Text>
      ),
      labels: { confirm: "Close application", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => archive(r.id),
    });
  };

  // Board reopen of a closed application — the server restores the step it was
  // closed from, or refuses with the reason.
  const unarchive = (processId: number) => post(processId, "unarchive", {}, "Application reopened.");
  const certify = (processId: number, reason: string) => post(processId, "certify-payment", { reason }, "Certified — membership activated.");
  const recordRefund = (processId: number, reason: string) => post(processId, "refund", { reason }, "Refund recorded.");

  const handleRefund = (processId: number) => {
    setPendingRefund(processId);
    setRefundReason("");
    openRefund();
  };

  const confirmRefund = async () => {
    if (pendingRefund === null || !refundReason.trim()) return;
    closeRefund();
    const processId = pendingRefund;
    setPendingRefund(null);
    await recordRefund(processId, refundReason.trim());
  };

  const handleCertify = (processId: number) => {
    setPendingCertify(processId);
    setCertifyReason("");
    openCertify();
  };

  const confirmCertify = async () => {
    if (pendingCertify === null || !certifyReason.trim()) return;
    closeCertify();
    const processId = pendingCertify;
    const reason = certifyReason.trim();
    setPendingCertify(null);
    await certify(processId, reason);
  };


  // A per-person process has no household; it is named for its subject person.
  const processLabel = (r: ProcessRow) => {
    if (!r.orgMembership && r.subjectPerson) return r.subjectPerson.name || `Person #${r.subjectPerson.id}`;
    const hh = r.orgMembership?.household;
    if (!hh) return `Household #${r.orgMembership?.householdId ?? "?"}`;
    const parents = (hh.householdMembers || []).filter((p) => p.isHouseholdLead).map((p) => p.name || p.email).filter(Boolean);
    return hh.name || parents.join(" & ") || `Household #${r.orgMembership?.householdId}`;
  };

  const [settling, setSettling] = useState(false);
  const settleWaiting = async () => {
    setSettling(true);
    try {
      const { households, opened, failed } = await api<{ households: number; opened: number; failed: number }>(
        "/api/membership-ops/applications/settle-waiting",
        { method: "POST", invalidate: false },
      );
      clearError("settle-waiting");
      const failedNote = failed > 0 ? ` ${failed} failed: see System Status.` : "";
      const summary = `Re-checked ${households} household(s); ${opened} moved on.${failedNote}`;
      if (failed > 0) showWarning(summary, { key: "settle-waiting" });
      else showSuccess(summary);
      notifyNavRefresh();
      await reload();
    } catch (e) {
      showError(errorMessage(e), { key: "settle-waiting", title: "Fix pending background checks" });
    } finally {
      setSettling(false);
    }
  };
  const confirmSettleWaiting = () => {
    modals.openConfirmModal({
      title: "Re-check every application waiting on a background check?",
      children: (
        <Text size="sm">
          Each household whose application waits on a background check is checked again. One whose
          lead already holds a valid check moves on.
        </Text>
      ),
      labels: { confirm: "Re-check", cancel: "Cancel" },
      onConfirm: () => { void settleWaiting(); },
    });
  };

  const statusCounts = rows.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  // The status-filter badges/notice are meaningless on the closed view (every
  // row is ARCHIVED) — the filter itself is ignored there too.
  const notRenewingCount = rows.filter((r) => r.notRenewing).length;
  const visibleRows = rows.filter((r) => showArchived || !active || (active === NOT_RENEWING ? r.notRenewing : r.status === active));

  return (
    <Stack>
      <Text c="dimmed">
        In-flight applications. Use the manual controls below to confirm the contract was signed
        or to mark a lead&apos;s background check started. (The contract is also confirmed
        automatically once the Zoho webhook is configured.)
      </Text>

      {me?.isBoardMember && !showArchived && (
        <Group>
          <Button variant="light" loading={settling} onClick={confirmSettleWaiting}>Fix pending background checks</Button>
        </Group>
      )}

      <Switch
        label="Show closed applications"
        checked={showArchived}
        onChange={(e) => setShowArchived(e.currentTarget.checked)}
      />

      {rows.length > 0 && !showArchived && (
        <>
          {rows.some((r) => r.status === "BLOCKED") && (
            <Alert
              color="red"
              variant="light"
              fw={600}
              onClick={() => toggle("BLOCKED")}
              title="Click to filter to blocked applications"
              style={{ cursor: "pointer" }}
            >
              🚨 {rows.filter((r) => r.status === "BLOCKED").length} application(s) blocked at
              background review — board attention needed.
            </Alert>
          )}
          <Group gap="xs">
            {Object.entries(statusCounts).map(([status, count]) => (
              <StatusFilterBadge key={status} value={status} active={active} onToggle={toggle} color={statusColor(status)}>
                {statusLabel(status)}: {count}
              </StatusFilterBadge>
            ))}
            {notRenewingCount > 0 && (
              <StatusFilterBadge value={NOT_RENEWING} active={active} onToggle={toggle} color="gray">
                Not renewing: {notRenewingCount}
              </StatusFilterBadge>
            )}
          </Group>
        </>
      )}

      {!showArchived && <ActiveFilterNotice active={active} label={statusLabel} onClear={clear} />}

      {loadError && <LoadError what="applications" message={loadError} onRetry={reload} />}

      {data === null ? (
        !loadError && <Center py="xl"><Loader /></Center>
      ) : rows.length === 0 ? (
        <Card withBorder radius="md" padding="xl" ta="center">
          <Text c="dimmed">{showArchived ? "No closed applications." : "No in-flight membership applications."}</Text>
        </Card>
      ) : visibleRows.length === 0 ? (
        <Card withBorder radius="md" padding="xl" ta="center">
          <Stack align="center" gap="xs">
            <Text c="dimmed">
              No applications in {statusLabel(active as string)} — clear the filter to see everything.
            </Text>
            <Button size="xs" variant="light" onClick={clear}>Clear filter</Button>
          </Stack>
        </Card>
      ) : (
        <Stack>
          {visibleRows.map((r) => (
            <Card key={r.id} withBorder radius="md" padding="lg">
              <Group justify="space-between" align="center" wrap="wrap">
                <div>
                  <Text fw={700} fz="lg">{processLabel(r)}</Text>
                  <Text size="xs" c="dimmed">
                    {kindLabel(r.kind)} · application #{r.id}
                    {r.orgMembership?.isVolunteerFamily && <Text component="span" c="green"> · volunteer</Text>}
                  </Text>
                </div>
                <Group gap="xs">
                  {r.notRenewing && (
                    <StatusFilterBadge value={NOT_RENEWING} active={active} onToggle={toggle} color="gray">
                      Not renewing
                    </StatusFilterBadge>
                  )}
                  <StatusFilterBadge value={r.status} active={active} onToggle={toggle} color={statusColor(r.status)}>
                    {statusLabel(r.status)}
                  </StatusFilterBadge>
                </Group>
              </Group>

              {r.status === "PENDING_EXTERNAL_ACTION" && (
                <Group gap="xl" wrap="wrap" mt="md">
                  <div>
                    <Text size="xs" c="dimmed" mb={4}>Contract</Text>
                    {r.contractSignedAt ? (
                      <Text c="green" fw={600}>✓ Signed</Text>
                    ) : (
                      <Button size="xs" fz={15} disabled={busyId === r.id || ownHousehold(r)} onClick={() => act(r.id, "mark-contract")}>
                        Confirm contract signed
                      </Button>
                    )}
                  </div>
                  <div>
                    <Text size="xs" c="dimmed" mb={4}>Background check started</Text>
                    {householdCheckStarted(r, rows) ? (
                      <Text c="green" fw={600}>✓ Started</Text>
                    ) : (
                      <Button size="xs" fz={15} variant="default" disabled={busyId === r.id || leadsOf(r).length === 0} onClick={() => confirmMarkLead(r)}>
                        Mark a lead&apos;s check started
                      </Button>
                    )}
                  </div>
                  {ownHousehold(r) && !r.contractSignedAt && (
                    <Text size="xs" c="dimmed">You can&apos;t confirm your own household&apos;s contract — someone outside your household must.</Text>
                  )}
                </Group>
              )}

              {awaitingBg(r) && (
                <Group mt="md" gap="md" wrap="wrap" align="center">
                  <Text size="sm" c="dimmed">
                    Background check — <Text component="span" fw={600}>{approvals(r)}/2</Text> approvals toward clearance
                    {r.subjectPerson ? "." : "; the first reviewer names the person."}
                  </Text>
                  {/* The board's way back from a reviewer's misclick: the review is still
                      open, so discarding the attestations undoes it with nothing to unwind. */}
                  {me?.isBoardMember && approvals(r) > 0 && (
                    <Button size="xs" fz={15} variant="default" disabled={busyId === r.id || ownHousehold(r)} onClick={() => confirmResetReview(r)}>
                      Discard approvals — start the review over
                    </Button>
                  )}
                  {me?.isBoardMember && r.attestations.length === 0 && (
                    <Button size="xs" fz={15} variant="default" disabled={busyId === r.id || ownHousehold(r)} onClick={() => confirmDismiss(r)}>
                      Dismiss: opened by mistake
                    </Button>
                  )}
                  {wrongPersonClose(r)}
                </Group>
              )}

              {waitingOnCheckReview(r, rows) && (
                <Text size="sm" c="dimmed" mt="md">
                  Background check (in parallel) — waiting on the household&apos;s check review.
                </Text>
              )}

              {r.status === "PENDING_PAYMENT" && (
                <Group mt="md" gap="md" wrap="wrap" align="center">
                  <Text size="sm" c="dimmed">Awaiting payment.</Text>
                  {me?.isBoardMember && (
                    <Button size="xs" fz={15} disabled={busyId === r.id || ownHousehold(r)} onClick={() => handleCertify(r.id)}>
                      Activate without payment{r.bgClearedAt ? "" : " (holds for background check)"}
                    </Button>
                  )}
                  {me?.isBoardMember && ownHousehold(r) && (
                    <Text size="xs" c="dimmed">You can&apos;t certify your own household&apos;s application — someone outside your household must.</Text>
                  )}
                </Group>
              )}

              {r.status === "PENDING_BG_CLEARANCE" && (
                <Text size="sm" c="dimmed" mt="md">
                  Paid — membership activates automatically once the background check clears.
                </Text>
              )}

              {r.status === "BLOCKED" && (
                <Alert color="red" variant="light" mt="md" title="🚨 Blocked at background review — needs board attention.">
                  {r.paidAt && (
                    <Text size="sm" c="red" fw={700} mb="sm">
                      💸 This household already paid — a refund is likely needed (membership was not activated).
                    </Text>
                  )}
                  {me?.isBoardMember ? (
                    <>
                      <Text size="sm" mb="sm">
                        A reset sends the review back for two new approvals. The reviewer who rejected
                        may also change their answer to approve, which does the same and counts as the first.
                        An application blocked by a person&apos;s check review moves on when that review is reset.
                      </Text>
                      <Group gap="xs">
                        <Button size="xs" fz={15} variant="default" disabled={busyId === r.id || ownHousehold(r)} onClick={() => confirmResetReview(r)}>
                          Reset for re-review
                        </Button>
                        {wrongPersonClose(r)}
                        {releasable(r) && (
                          <Button size="xs" fz={15} variant="default" disabled={busyId === r.id || ownHousehold(r)} onClick={() => confirmRelease(r)}>
                            Release
                          </Button>
                        )}
                      </Group>
                      {releasable(r) && (
                        <Text size="xs" c="dimmed" mt="sm">Nobody in this household is under a rejected check review now, so the Board can release it.</Text>
                      )}
                      {ownHousehold(r) && (
                        <Text size="xs" c="dimmed" mt="sm">You can&apos;t reset or release your own household&apos;s application — someone outside your household must.</Text>
                      )}
                    </>
                  ) : (
                    <Text size="sm" c="dimmed">A board member can reset this review.</Text>
                  )}
                </Alert>
              )}

              {!showArchived && refundable(r) && (
                <Group mt="md" gap="md" wrap="wrap" align="center">
                  <Button size="xs" fz={15} variant="default" disabled={busyId === r.id || ownHousehold(r)} onClick={() => handleRefund(r.id)}>
                    Record refund
                  </Button>
                  <Text size="xs" c="dimmed">
                    {ownHousehold(r)
                      ? "You can't record a refund on your own household's application — someone outside your household must."
                      : r.status === "BLOCKED"
                        ? "After refunding in Shopify. The application stays blocked."
                        : "After refunding in Shopify. The application goes back to awaiting payment; the background check is unchanged."}
                  </Text>
                </Group>
              )}

              <Group justify="flex-end" mt="md">
                {showArchived ? (
                  <Group gap="md" wrap="wrap" align="center">
                    {yearRefusal(r) && <Text size="xs" c="dimmed">{yearRefusal(r)}</Text>}
                    {me?.isBoardMember && r.kind === "PERSON_BG" && (
                      <Button size="xs" fz={15} variant="default" disabled={busyId === r.id || ownHousehold(r)} onClick={() => confirmReopenWrongPerson(r)}>
                        Reopen: closed as wrong person
                      </Button>
                    )}
                    <Button size="xs" fz={15} disabled={busyId === r.id || ownHousehold(r) || !!yearRefusal(r)} onClick={() => unarchive(r.id)}>
                      Reopen
                    </Button>
                  </Group>
                ) : closable(r) && (
                  <Button size="xs" fz={15} variant="subtle" color="red" disabled={busyId === r.id || ownHousehold(r)} onClick={() => confirmArchive(r)}>
                    Close application
                  </Button>
                )}
              </Group>
            </Card>
          ))}
        </Stack>
      )}

      <Modal
        opened={certifyOpened}
        onClose={closeCertify}
        title={<Text span fw={700} fz="lg">Activate Without Payment</Text>}
        centered
      >
        <Text mb="sm">
          Activate this household&apos;s membership without a Shopify payment? Use this when the
          board has agreed payment outside Shopify. It holds for background clearance if that
          isn&apos;t done yet.
        </Text>
        <Textarea
          value={certifyReason}
          onChange={(e) => setCertifyReason(e.currentTarget.value)}
          label="Reason"
          placeholder="Why is this being certified?"
          autosize
          minRows={3}
          mb="lg"
          required
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={closeCertify}>Cancel</Button>
          <Button onClick={confirmCertify} disabled={!certifyReason.trim()}>Certify</Button>
        </Group>
      </Modal>
      <Modal
        opened={refundOpened}
        onClose={closeRefund}
        title={<Text span fw={700} fz="lg">Record refund</Text>}
        centered
      >
        <Text mb="sm">
          Record that this household&apos;s membership payment was refunded in Shopify. This does
          not refund anything itself. The payment is cleared from the application; the background
          check is left as it is.
        </Text>
        <Textarea
          value={refundReason}
          onChange={(e) => setRefundReason(e.currentTarget.value)}
          label="Reason"
          placeholder="Why was this refunded?"
          autosize
          minRows={3}
          mb="lg"
          required
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={closeRefund}>Cancel</Button>
          <Button onClick={confirmRefund} disabled={!refundReason.trim()}>Record refund</Button>
        </Group>
      </Modal>
    </Stack>
  );
}
