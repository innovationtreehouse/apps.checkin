"use client";

import { Button, Group, Modal, Text, Textarea } from "@mantine/core";

export function RefundDialog({ opened, onClose, reason, onReasonChange, onConfirm }: {
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
      title={<Text span fw={700} fz="lg">Record refund</Text>}
      centered
    >
      <Text mb="sm">
        Record that this household&apos;s membership payment was refunded in Shopify. This does
        not refund anything itself. The payment is cleared from the application; the background
        check is left as it is.
      </Text>
      <Textarea
        value={reason}
        onChange={(e) => onReasonChange(e.currentTarget.value)}
        label="Reason"
        placeholder="Why was this refunded?"
        autosize
        minRows={3}
        mb="lg"
        required
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>Cancel</Button>
        <Button onClick={onConfirm} disabled={!reason.trim()}>Record refund</Button>
      </Group>
    </Modal>
  );
}
