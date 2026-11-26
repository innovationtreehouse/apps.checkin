"use client";

import { Switch, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { ReasonConfirm } from "@/components/ReasonConfirm";
import { LeadPickConfirm } from "./LeadPickConfirm";
import { leadsOf, processLabel, type ProcessRow } from "./applicationRows";

export const confirmMarkLead = (r: ProcessRow, markLeadCheckStarted: (personId: number) => void) => {
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
          markLeadCheckStarted(personId);
        }}
      />
    ),
  });
};

export const confirmDismiss = (r: ProcessRow, dismissReview: (reason: string) => void) => {
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
          dismissReview(reason);
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

// Every reset takes a reason. A review a household asked for can also be reset as
// naming the wrong person, which returns it to no person.
export const confirmResetReview = (r: ProcessRow, resetReview: (reason: string, wrongPerson: boolean) => void) => {
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
          resetReview(reason, wrongPerson);
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
export const confirmCloseWrongPerson = (r: ProcessRow, closeWrongPerson: (reason: string) => void) => {
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
          closeWrongPerson(reason);
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

export const confirmReopenWrongPerson = (r: ProcessRow, reopenWrongPerson: (reason: string) => void) => {
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
          reopenWrongPerson(reason);
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

export const confirmRelease = (r: ProcessRow, releaseApplication: (reason: string) => void) => {
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
          releaseApplication(reason);
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
export const confirmArchive = (r: ProcessRow, archive: () => void) => {
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
    onConfirm: () => archive(),
  });
};
