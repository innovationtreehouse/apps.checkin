"use client";

import { Alert, Button, Card, Group, Text } from "@mantine/core";
import { StatusFilterBadge } from "@/components/StatusFilter";
import {
  NOT_RENEWING, approvals, awaitingBg, closable, householdCheckStarted, kindLabel, leadsOf, processLabel, refundable,
  releasable, statusColor, statusLabel, waitingOnCheckReview, type ProcessRow,
} from "./applicationRows";
import {
  confirmArchive, confirmCloseWrongPerson, confirmDismiss, confirmMarkLead, confirmRelease, confirmReopenWrongPerson,
  confirmResetReview,
} from "./applicationConfirms";

export interface ApplicationActions {
  act: (processId: number, action: string) => void;
  resetReview: (processId: number, reason: string, wrongPerson: boolean) => void;
  releaseApplication: (processId: number, reason: string) => void;
  closeWrongPerson: (processId: number, reason: string) => void;
  reopenWrongPerson: (processId: number, reason: string) => void;
  archive: (processId: number) => void;
  unarchive: (processId: number) => void;
  markLeadCheckStarted: (processId: number, personId: number) => void;
  dismissReview: (processId: number, reason: string) => void;
  handleCertify: (processId: number) => void;
  handleRefund: (processId: number) => void;
}

export function ApplicationCard({ r, rows, isBoardMember, busy, ownHousehold, active, toggle, showArchived, yearRefusal, actions }: {
  r: ProcessRow;
  rows: readonly ProcessRow[];
  isBoardMember: boolean;
  busy: boolean;
  ownHousehold: boolean;
  active: string | null;
  toggle: (value: string) => void;
  showArchived: boolean;
  yearRefusal: string | null;
  actions: ApplicationActions;
}) {
  const wrongPersonClose = isBoardMember && r.kind === "PERSON_BG" && (
    <Button size="xs" fz={15} variant="default" color="red" disabled={busy || ownHousehold} onClick={() => confirmCloseWrongPerson(r, (reason) => actions.closeWrongPerson(r.id, reason))}>
      Close: opened for the wrong person
    </Button>
  );
  const resetReview = () => confirmResetReview(r, (reason, wrongPerson) => actions.resetReview(r.id, reason, wrongPerson));

  return (
    <Card withBorder radius="md" padding="lg">
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
              <Button size="xs" fz={15} disabled={busy || ownHousehold} onClick={() => actions.act(r.id, "mark-contract")}>
                Confirm contract signed
              </Button>
            )}
          </div>
          <div>
            <Text size="xs" c="dimmed" mb={4}>Background check started</Text>
            {householdCheckStarted(r, rows) ? (
              <Text c="green" fw={600}>✓ Started</Text>
            ) : (
              <Button size="xs" fz={15} variant="default" disabled={busy || leadsOf(r).length === 0} onClick={() => confirmMarkLead(r, (personId) => actions.markLeadCheckStarted(r.id, personId))}>
                Mark a lead&apos;s check started
              </Button>
            )}
          </div>
          {ownHousehold && !r.contractSignedAt && (
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
          {isBoardMember && approvals(r) > 0 && (
            <Button size="xs" fz={15} variant="default" disabled={busy || ownHousehold} onClick={resetReview}>
              Discard approvals — start the review over
            </Button>
          )}
          {isBoardMember && r.attestations.length === 0 && (
            <Button size="xs" fz={15} variant="default" disabled={busy || ownHousehold} onClick={() => confirmDismiss(r, (reason) => actions.dismissReview(r.id, reason))}>
              Dismiss: opened by mistake
            </Button>
          )}
          {wrongPersonClose}
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
          {isBoardMember && (
            <Button size="xs" fz={15} disabled={busy || ownHousehold} onClick={() => actions.handleCertify(r.id)}>
              Activate without payment{r.bgClearedAt ? "" : " (holds for background check)"}
            </Button>
          )}
          {isBoardMember && ownHousehold && (
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
          {isBoardMember ? (
            <>
              <Text size="sm" mb="sm">
                A reset sends the review back for two new approvals. The reviewer who rejected
                may also change their answer to approve, which does the same and counts as the first.
                An application blocked by a person&apos;s check review moves on when that review is reset.
              </Text>
              <Group gap="xs">
                <Button size="xs" fz={15} variant="default" disabled={busy || ownHousehold} onClick={resetReview}>
                  Reset for re-review
                </Button>
                {wrongPersonClose}
                {releasable(r, rows) && (
                  <Button size="xs" fz={15} variant="default" disabled={busy || ownHousehold} onClick={() => confirmRelease(r, (reason) => actions.releaseApplication(r.id, reason))}>
                    Release
                  </Button>
                )}
              </Group>
              {releasable(r, rows) && (
                <Text size="xs" c="dimmed" mt="sm">Nobody in this household is under a rejected check review now, so the Board can release it.</Text>
              )}
              {ownHousehold && (
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
          <Button size="xs" fz={15} variant="default" disabled={busy || ownHousehold} onClick={() => actions.handleRefund(r.id)}>
            Record refund
          </Button>
          <Text size="xs" c="dimmed">
            {ownHousehold
              ? "You can't record a refund on your own household's application — someone outside your household must."
              : r.status === "BLOCKED"
                ? "After refunding in Shopify. The application stays blocked, or closes if the household is denied."
                : "After refunding in Shopify. The application goes back to awaiting payment, or closes if the household is denied; the background check is unchanged."}
          </Text>
        </Group>
      )}

      <Group justify="flex-end" mt="md">
        {showArchived ? (
          <Group gap="md" wrap="wrap" align="center">
            {yearRefusal && <Text size="xs" c="dimmed">{yearRefusal}</Text>}
            {isBoardMember && r.kind === "PERSON_BG" && (
              <Button size="xs" fz={15} variant="default" disabled={busy || ownHousehold} onClick={() => confirmReopenWrongPerson(r, (reason) => actions.reopenWrongPerson(r.id, reason))}>
                Reopen: closed as wrong person
              </Button>
            )}
            <Button size="xs" fz={15} disabled={busy || ownHousehold || !!yearRefusal} onClick={() => actions.unarchive(r.id)}>
              Reopen
            </Button>
          </Group>
        ) : closable(r) && (
          <Button size="xs" fz={15} variant="subtle" color="red" disabled={busy || ownHousehold} onClick={() => confirmArchive(r, () => actions.archive(r.id))}>
            Close application
          </Button>
        )}
      </Group>
    </Card>
  );
}
