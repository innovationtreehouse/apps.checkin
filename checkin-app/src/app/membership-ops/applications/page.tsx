"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { Alert, Button, Card, Center, Group, Loader, Modal, Radio, Stack, Switch, Text, Textarea } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { AlertBanner } from "@/components/admin/AlertBanner";
import { notifications } from "@mantine/notifications";
import { modals } from "@mantine/modals";
import { useSession } from "next-auth/react";
import { notifyNavRefresh } from "@/lib/nav-refresh";
import { sharesHousehold } from "@/lib/conflictOfInterest";
import { PageLoader } from "@/components/ui/PageLoader";
import { StatusFilterBadge, ActiveFilterNotice, useStatusFilter } from "@/components/StatusFilter";
import { awaitingBgReview, type ProcessStatus } from "@/lib/membership/lifecycle";
import { clearingApprovals } from "@/lib/membership/approvals";

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
  isMarkedVolunteer: boolean;
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
  orgMembership: {
    householdId: number;
    isVolunteer: boolean;
    household: { name: string | null; householdMembers: Person[] } | null;
  } | null;
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

const statusColor = (status: string) => STATUS_COLORS[status] || "gray";
const statusLabel = (status: string) => status.replace(/_/g, " ");

// The background check is a parallel track: an application still needs review
// when it hasn't cleared and is past consent. ONE definition, shared with the
// server (fix #1): awaitingBgReview.has — client-safe (booleans in, no Prisma).
const awaitingBg = (r: ProcessRow) =>
  awaitingBgReview.has({ status: r.status as ProcessStatus, bgConsentAt: !!r.bgConsentAt, bgClearedAt: !!r.bgClearedAt });

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
  // Conflict of interest: no actor may advance/certify/override their OWN household's
  // application (mirrors the server guards in certifyPaymentPlan, overrideBlocked and
  // the EXTERNAL-phase route).
  // The disabled state is UX only — the server is the real enforcement.
  const ownHousehold = (r: ProcessRow) =>
    sharesHousehold(me?.householdId, r.orgMembership?.householdId);
  const [rows, setRows] = useState<ProcessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [messageId, setMessageId] = useState<number | null>(null);
  const { active, toggle, clear } = useStatusFilter();
  const [certifyOpened, { open: openCertify, close: closeCertify }] = useDisclosure(false);
  const [pendingCertify, setPendingCertify] = useState<number | null>(null);
  const [certifyReason, setCertifyReason] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  // processId -> the lead a force-approve asserts was checked. The board asserts it
  // because a blocked review has no second approval to count.
  const [overrideSubjects, setOverrideSubjects] = useState<Record<number, number>>({});

  const load = useCallback(async (archived: boolean) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/membership-ops/applications${archived ? "?archived=1" : ""}`);
      if (res.ok) {
        const data = await res.json();
        setRows(data.processes || []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(showArchived); }, [load, showArchived]);

  const act = async (processId: number, action: string, extra?: Record<string, unknown>) => {
    setBusyId(processId);
    setMessageId(processId);
    setMessage("");
    try {
      const res = await fetch("/api/membership-ops/applications/external", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId, action, ...extra }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notifications.show({ message: "Updated." });
        await load(showArchived);
        notifyNavRefresh();
      } else {
        setMessage(data.error || "Action failed.");
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setBusyId(null);
    }
  };

  const override = async (processId: number, action: "reset" | "approve") => {
    setBusyId(processId);
    setMessageId(processId);
    setMessage("");
    try {
      const res = await fetch("/api/membership-ops/applications/review-override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId, action, subjectPersonIds: overrideSubjects[processId] === undefined ? [] : [overrideSubjects[processId]] }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notifications.show({ message: action === "reset" ? "Sent back for re-review." : "Overridden to payment." });
        await load(showArchived);
        notifyNavRefresh();
      } else if (data.code === "wrong_phase") {
        notifications.show({ color: "red", message: data.error || "This application is no longer blocked.", autoClose: 4000 });
        await load(showArchived);
      } else {
        setMessage(data.error || "Override failed.");
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setBusyId(null);
    }
  };

  const archive = async (processId: number) => {
    setBusyId(processId);
    setMessageId(processId);
    setMessage("");
    try {
      const res = await fetch("/api/membership-ops/applications/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notifications.show({ message: "Application archived." });
        await load(showArchived);
        notifyNavRefresh();
      } else {
        setMessage(data.error || "Archive failed.");
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setBusyId(null);
    }
  };

  // An awaiting row only ever holds APPROVE attestations (any REJECT blocks it).
  const approvals = (r: ProcessRow) => r.attestations.filter((a) => a.result === "APPROVE").length;
  // Approvals that count toward clearing; unnamed or other-adult approvals don't.
  const counted = (r: ProcessRow) => clearingApprovals(r.attestations, r.kind === "PERSON_BG");

  const confirmResetReview = (r: ProcessRow) => {
    modals.openConfirmModal({
      title: "Start this background-check review over?",
      children: (
        <Text size="sm">
          This discards the {approvals(r)} approval(s) recorded for <strong>{householdLabel(r)}</strong>{" "}
          and asks the reviewers to start again. Use it when an approval was recorded by
          mistake — the check itself has not cleared yet, so nothing else changes.
        </Text>
      ),
      labels: { confirm: "Discard approvals", cancel: "Cancel" },
      onConfirm: () => override(r.id, "reset"),
    });
  };

  // Disposing an abandoned application removes it from the board list. Confirm
  // because it's a deliberate cleanup action (kept in the audit log, not deleted).
  const confirmArchive = (r: ProcessRow) => {
    modals.openConfirmModal({
      title: "Archive this application?",
      children: (
        <Text size="sm">
          This removes <strong>{householdLabel(r)}</strong> (application #{r.id}) from the board list.
          A record is kept in the audit log. Only do this for abandoned applications.
        </Text>
      ),
      labels: { confirm: "Archive", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => archive(r.id),
    });
  };

  // Board recovery of a wrongly-archived application — restores it to whatever
  // in-flight status it was archived from (server-determined from the audit trail).
  const unarchive = async (processId: number) => {
    setBusyId(processId);
    setMessageId(processId);
    setMessage("");
    try {
      const res = await fetch("/api/membership-ops/applications/unarchive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notifications.show({ message: "Application unarchived." });
        await load(showArchived);
        notifyNavRefresh();
      } else {
        notifications.show({ color: "red", message: data.error || "Unarchive failed.", autoClose: 4000 });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setBusyId(null);
    }
  };

  const certify = async (processId: number, reason: string) => {
    setBusyId(processId);
    setMessageId(processId);
    setMessage("");
    try {
      const res = await fetch("/api/membership-ops/applications/certify-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId, reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notifications.show({ message: "Certified — membership activated." });
        await load(showArchived);
        notifyNavRefresh();
      } else if (data.code === "wrong_phase") {
        notifications.show({ color: "red", message: data.error || "This application is no longer awaiting payment.", autoClose: 4000 });
        await load(showArchived);
      } else {
        setMessage(data.error || "Certification failed.");
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setBusyId(null);
    }
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

  const leads = (r: ProcessRow) => (r.orgMembership?.household?.householdMembers ?? []).filter((p) => p.isHouseholdLead);

  const pickOverrideSubject = (processId: number, personId: number) =>
    setOverrideSubjects((s) => ({ ...s, [processId]: personId }));

  const householdLabel = (r: ProcessRow) => {
    const hh = r.orgMembership?.household;
    if (!hh) return `Household #${r.orgMembership?.householdId ?? "?"}`;
    const parents = (hh.householdMembers || []).filter((p) => p.isHouseholdLead).map((p) => p.name || p.email).filter(Boolean);
    return hh.name || parents.join(" & ") || `Household #${r.orgMembership?.householdId}`;
  };

  const statusCounts = rows.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  // The status-filter badges/notice are meaningless on the archived view (every
  // row is ARCHIVED) — the filter itself is ignored there too.
  const visibleRows = rows.filter((r) => showArchived || !active || r.status === active);

  return (
    <Stack>
      <Text c="dimmed">
        In-flight applications. Use the manual controls below to confirm the contract was signed
        or that background-check consent was received. (The contract is also confirmed
        automatically once the Zoho webhook is configured.)
      </Text>

      <Switch
        label="Show archived"
        checked={showArchived}
        onChange={(e) => setShowArchived(e.currentTarget.checked)}
      />

      {!loading && rows.length > 0 && !showArchived && (
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
          </Group>
        </>
      )}

      {!showArchived && <ActiveFilterNotice active={active} label={statusLabel} onClear={clear} />}

      {loading ? (
        <Center py="xl"><Loader /></Center>
      ) : rows.length === 0 ? (
        <Card withBorder radius="md" padding="xl" ta="center">
          <Text c="dimmed">{showArchived ? "No archived applications." : "No in-flight membership applications."}</Text>
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
                  <Text fw={700} fz="lg">{householdLabel(r)}</Text>
                  <Text size="xs" c="dimmed">
                    {r.kind} · application #{r.id}
                    {r.orgMembership?.isVolunteer && <Text component="span" c="green"> · volunteer</Text>}
                  </Text>
                </div>
                <StatusFilterBadge value={r.status} active={active} onToggle={toggle} color={statusColor(r.status)}>
                  {statusLabel(r.status)}
                </StatusFilterBadge>
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
                    <Text size="xs" c="dimmed" mb={4}>Background-check consent</Text>
                    {r.bgConsentAt ? (
                      <Text c="green" fw={600}>✓ Received</Text>
                    ) : (
                      <Button size="xs" fz={15} variant="default" disabled={busyId === r.id || ownHousehold(r)} onClick={() => act(r.id, "mark-bg-consent")}>
                        Confirm BG consent
                      </Button>
                    )}
                  </div>
                  {ownHousehold(r) && (
                    <Text size="xs" c="dimmed">You can&apos;t confirm your own household&apos;s contract or consent — someone outside your household must.</Text>
                  )}
                </Group>
              )}

              {awaitingBg(r) && (
                <Group mt="md" gap="md" wrap="wrap" align="center">
                  <Text size="sm" c="dimmed">
                    Background check (in parallel) — <Text component="span" fw={600}>{counted(r)}/2</Text> approvals toward clearance.
                    {approvals(r) > counted(r) && ` ${approvals(r) - counted(r)} more recorded that name no one or a different adult — start the review over to clear it.`}
                  </Text>
                  {/* The board's way back from a reviewer's misclick: the review is still
                      open, so discarding the attestations undoes it with nothing to unwind. */}
                  {approvals(r) > 0 && (
                    <Button size="xs" fz={15} variant="default" disabled={busyId === r.id || ownHousehold(r)} onClick={() => confirmResetReview(r)}>
                      Discard approvals — start the review over
                    </Button>
                  )}
                </Group>
              )}

              {r.status === "PENDING_PAYMENT" && (
                <Group mt="md" gap="md" wrap="wrap" align="center">
                  <Text size="sm" c="dimmed">Awaiting payment.</Text>
                  <Button size="xs" fz={15} disabled={busyId === r.id || ownHousehold(r)} onClick={() => handleCertify(r.id)}>
                    Certify payment plan → {r.bgClearedAt ? "activate" : "(holds for background check)"}
                  </Button>
                  {ownHousehold(r) && (
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
                  {/* A force-approve must say which adult it covers: a blocked review has
                      no second approval to count, so an unnamed override would set
                      bgClearedAt with nobody recorded as checked. */}
                  <Stack gap={4} mb="sm">
                    {leads(r).length === 0 ? (
                      <Text size="sm" c="dimmed">No household leads on file — this application cannot be overridden.</Text>
                    ) : (
                      <Radio.Group
                        label="Whose background check does an override cover?"
                        value={String(overrideSubjects[r.id] ?? "")}
                        onChange={(v) => pickOverrideSubject(r.id, Number(v))}
                      >
                        <Stack gap={4} mt={4}>
                          {leads(r).map((p) => (
                            <Radio key={p.id} size="xs" value={String(p.id)} label={p.name || p.email || `Person #${p.id}`} />
                          ))}
                        </Stack>
                      </Radio.Group>
                    )}
                  </Stack>
                  <Group gap="sm" wrap="wrap">
                    <Button size="xs" fz={15} variant="default" disabled={busyId === r.id || ownHousehold(r)} onClick={() => override(r.id, "reset")}>
                      Reset for re-review
                    </Button>
                    <Button
                      size="xs"
                      fz={15}
                      disabled={busyId === r.id || ownHousehold(r) || overrideSubjects[r.id] === undefined}
                      onClick={() => override(r.id, "approve")}
                    >
                      Override → {r.paidAt ? "activate" : "payment"}
                    </Button>
                  </Group>
                  {ownHousehold(r) && (
                    <Text size="xs" c="dimmed" mt="sm">You can&apos;t override your own household&apos;s application — someone outside your household must.</Text>
                  )}
                </Alert>
              )}

              {messageId === r.id && (
                <AlertBanner message={message} tone="error" mt="md" />
              )}

              <Group justify="flex-end" mt="md">
                {showArchived ? (
                  <Button size="xs" fz={15} disabled={busyId === r.id} onClick={() => unarchive(r.id)}>
                    Unarchive
                  </Button>
                ) : (
                  <Button size="xs" fz={15} variant="subtle" color="red" disabled={busyId === r.id} onClick={() => confirmArchive(r)}>
                    Archive
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
        title={<Text span fw={700} fz="lg">Certify Payment Plan</Text>}
        centered
      >
        <Text mb="sm">
          Certify this payment plan? This activates the household&apos;s membership without a
          Shopify payment (holding for background clearance if it isn&apos;t done yet).
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
    </Stack>
  );
}
