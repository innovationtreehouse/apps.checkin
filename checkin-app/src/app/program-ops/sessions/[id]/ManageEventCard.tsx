"use client";

import { Alert, Button, Card, Checkbox, Group, SimpleGrid, Stack, TextInput, Title } from '@mantine/core';

export function ManageEventCard({
  editMode, setEditMode, newStart, setNewStart, newEnd, setNewEnd,
  applyToFuture, setApplyToFuture, recurringGroupId, actionLoading, onSave, onCancelClick,
}: {
  editMode: boolean;
  setEditMode: (editMode: boolean) => void;
  newStart: string;
  setNewStart: (value: string) => void;
  newEnd: string;
  setNewEnd: (value: string) => void;
  applyToFuture: boolean;
  setApplyToFuture: (applyToFuture: boolean) => void;
  recurringGroupId: string | null;
  actionLoading: boolean;
  onSave: () => void;
  onCancelClick: () => void;
}) {
  return (
    <Card withBorder radius="md" padding="lg" mb="lg">
      <Title order={4} mb="lg">Manage Event</Title>

      {!editMode ? (
        <Group>
          <Button variant="light" onClick={() => setEditMode(true)}>Edit Date / Time</Button>
          <Button variant="light" color="red" onClick={() => setEditMode(true)}>Cancel Event</Button>
        </Group>
      ) : (
        <Stack>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput type="datetime-local" label="Start Time" value={newStart} onChange={e => setNewStart(e.currentTarget.value)} />
            <TextInput type="datetime-local" label="End Time" value={newEnd} onChange={e => setNewEnd(e.currentTarget.value)} />
          </SimpleGrid>

          {recurringGroupId && (
            <Alert color="yellow" variant="light">
              <Checkbox
                checked={applyToFuture}
                onChange={e => setApplyToFuture(e.currentTarget.checked)}
                label={<span><strong>Apply to Series:</strong> Apply these changes (time shift or cancellation) to this event and all FUTURE events in this recurring set.</span>}
              />
            </Alert>
          )}

          <Group>
            <Button onClick={onSave} disabled={actionLoading} loading={actionLoading}>Save Time Changes</Button>
            <Button color="red" variant="light" onClick={onCancelClick} disabled={actionLoading} loading={actionLoading}>Cancel Event(s)</Button>
            <Button variant="default" onClick={() => setEditMode(false)} disabled={actionLoading} ml="auto">Nevermind</Button>
          </Group>
        </Stack>
      )}
    </Card>
  );
}
