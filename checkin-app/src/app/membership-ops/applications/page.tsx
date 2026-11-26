"use client";

import { useState, Suspense } from "react";
import { Button, Card, Center, Loader, Stack, Switch, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { errorMessage, HttpError, LoadError, showError, showSuccess } from "@checkin/component-ui";
import { useSession } from "next-auth/react";
import { api, useLoad } from "@/lib/api";
import { notifyNavRefresh } from "@/lib/nav-refresh";
import { sharesHousehold } from "@/lib/conflictOfInterest";
import { PageLoader } from "@/components/ui/PageLoader";
import { useStatusFilter } from "@/components/StatusFilter";
import { reopenYearRefusal } from "@/lib/programYear";
import { useMembershipYearBoundary } from "@/app/program-ops/ProgramYearField";
import { NOT_RENEWING, processLabel, statusLabel, type ProcessRow } from "./applicationRows";
import { ApplicationCard, type ApplicationActions } from "./ApplicationCard";
import { ApplicationsLegend } from "./ApplicationsLegend";
import { SettleWaitingButton } from "./SettleWaitingButton";
import { CertifyDialog } from "./CertifyDialog";
import { RefundDialog } from "./RefundDialog";

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

  const actions: ApplicationActions = {
    act, resetReview, releaseApplication, closeWrongPerson, reopenWrongPerson, archive, unarchive,
    markLeadCheckStarted, dismissReview, handleCertify, handleRefund,
  };

  const visibleRows = rows.filter((r) => showArchived || !active || (active === NOT_RENEWING ? r.notRenewing : r.status === active));

  return (
    <Stack>
      <Text c="dimmed">
        In-flight applications. Use the manual controls below to confirm the contract was signed
        or to mark a lead&apos;s background check started. (The contract is also confirmed
        automatically once the Zoho webhook is configured.)
      </Text>

      <SettleWaitingButton shown={!!me?.isBoardMember && !showArchived} reload={reload} />

      <Switch
        label="Show closed applications"
        checked={showArchived}
        onChange={(e) => setShowArchived(e.currentTarget.checked)}
      />

      <ApplicationsLegend rows={rows} active={active} toggle={toggle} clear={clear} showArchived={showArchived} />

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
            <ApplicationCard
              key={r.id}
              r={r}
              rows={rows}
              isBoardMember={!!me?.isBoardMember}
              busy={busyId === r.id}
              ownHousehold={ownHousehold(r)}
              active={active}
              toggle={toggle}
              showArchived={showArchived}
              yearRefusal={showArchived ? yearRefusal(r) : null}
              actions={actions}
            />
          ))}
        </Stack>
      )}

      <CertifyDialog opened={certifyOpened} onClose={closeCertify} reason={certifyReason} onReasonChange={setCertifyReason} onConfirm={confirmCertify} />
      <RefundDialog opened={refundOpened} onClose={closeRefund} reason={refundReason} onReasonChange={setRefundReason} onConfirm={confirmRefund} />
    </Stack>
  );
}
