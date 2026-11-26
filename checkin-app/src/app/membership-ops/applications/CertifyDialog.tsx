"use client";

import { Button, Group, Modal, Text, Textarea } from "@mantine/core";

export function CertifyDialog({ opened, onClose, reason, onReasonChange, onConfirm }: {
  opened: boolean;
  onClose: () => void;
  reason: string;
  onReasonChange: (reason: string) => void;
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
        <Button onClick={onConfirm} disabled={!reason.trim()}>Certify</Button>
      </Group>
    </Modal>
  );
}
