"use client";

import { Alert, Button, Checkbox, Group, Modal, Select, Text, Textarea } from "@mantine/core";
import { membershipYearLabel } from "@/lib/programYear";

/** The warning shown when the Board records a payment for a year other than the application's own. */
export function YearMismatchWarning({ appliedFor, paidFor, acknowledged, onAcknowledge }: {
  appliedFor: number | null;
  paidFor: number | null;
  acknowledged: boolean;
  onAcknowledge: (acknowledged: boolean) => void;
}) {
  if (appliedFor === null || paidFor === null || appliedFor === paidFor) return null;
  return (
    <Alert color="yellow" variant="light" mb="md">
      <Text size="sm" mb="xs">
        This application is for {membershipYearLabel(appliedFor)}. You are recording a payment for {membershipYearLabel(paidFor)}.
      </Text>
      <Checkbox
        label="I understand the year doesn't match the application"
        checked={acknowledged}
        onChange={(e) => onAcknowledge(e.currentTarget.checked)}
      />
    </Alert>
  );
}

/** True when the picked year differs from the application's and the Board hasn't acknowledged it. */
export const yearMismatchUnacknowledged = (appliedFor: number | null, paidFor: number | null, acknowledged: boolean) =>
  appliedFor !== null && paidFor !== null && appliedFor !== paidFor && !acknowledged;

export function CertifyDialog({ opened, onClose, reason, onReasonChange, years, year, onYearChange, appliedFor, acknowledged, onAcknowledge, onConfirm }: {
  opened: boolean;
  onClose: () => void;
  reason: string;
  onReasonChange: (reason: string) => void;
  years: { year: number; label: string }[];
  year: number | null;
  onYearChange: (year: number | null) => void;
  appliedFor: number | null;
  acknowledged: boolean;
  onAcknowledge: (acknowledged: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={<Text span fw={700} fz="lg">Activate Without Payment</Text>}
      centered
    >
      <Text mb="sm">
        Activate this household&apos;s membership without a Shopify payment? Use this when the
        board has agreed payment outside Shopify. It holds for background clearance if that
        isn&apos;t done yet.
      </Text>
      <Select
        label="Membership year this payment is for"
        placeholder="Choose a year"
        data={years.map((y) => ({ value: String(y.year), label: y.label }))}
        value={year === null ? null : String(year)}
        onChange={(v) => onYearChange(v === null ? null : Number(v))}
        mb="sm"
        required
      />
      <YearMismatchWarning appliedFor={appliedFor} paidFor={year} acknowledged={acknowledged} onAcknowledge={onAcknowledge} />
      <Textarea
        value={reason}
        onChange={(e) => onReasonChange(e.currentTarget.value)}
        label="Reason"
        placeholder="Why is this being certified?"
        autosize
        minRows={3}
        mb="lg"
        required
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>Cancel</Button>
        <Button onClick={onConfirm} disabled={!reason.trim() || year === null || yearMismatchUnacknowledged(appliedFor, year, acknowledged)}>Certify</Button>
      </Group>
    </Modal>
  );
}
