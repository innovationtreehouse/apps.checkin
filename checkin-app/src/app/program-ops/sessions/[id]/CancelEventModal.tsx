"use client";

import { Button, Group, Modal, Text } from '@mantine/core';

export function CancelEventModal({ opened, onClose, onConfirm, actionLoading }: {
  opened: boolean;
  onClose: () => void;
  onConfirm: () => void;
  actionLoading: boolean;
}) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={<Text span fw={700} fz="lg">Cancel Event</Text>}
      centered
    >
      <Text mb="lg">Are you sure you want to cancel this event? This action cannot be undone.</Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>Nevermind</Button>
        <Button color="red" onClick={onConfirm} disabled={actionLoading} loading={actionLoading}>Cancel Event(s)</Button>
      </Group>
    </Modal>
  );
}
