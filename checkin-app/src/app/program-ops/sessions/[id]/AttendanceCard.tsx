"use client";

import { Button, Card, Group, Text, Title } from '@mantine/core';
import { RosterGrid } from './RosterGrid';
import type { EventData, RosterMember, Visit } from './eventDetail';

export function AttendanceCard({ eventData, actionLoading, onConfirm, canManageAttendance, onManualEdit }: {
  eventData: EventData;
  actionLoading: boolean;
  onConfirm: () => void;
  canManageAttendance: boolean;
  onManualEdit: (member: RosterMember, visit: Visit | undefined) => void;
}) {
  return (
    <Card withBorder radius="md" padding="lg" mb="lg">
      <Group justify="space-between" align="center" wrap="wrap">
        <div>
          <Title order={4}>Attendance Tracking</Title>
          <Text c="dimmed">Review program badge scans below and confirm final attendance.</Text>
        </div>
        {eventData.attendanceConfirmedAt ? (
          <Group align="center" gap="md">
            <Text size="sm" c="dimmed" ta="right">
              Confirmed on {new Date(eventData.attendanceConfirmedAt).toLocaleDateString()}
              <br />by {eventData.attendanceConfirmedBy?.name || 'Unknown'}
            </Text>
            <Button variant="default" onClick={onConfirm} disabled={actionLoading}>Re-confirm</Button>
          </Group>
        ) : (
          <Button onClick={onConfirm} disabled={actionLoading} loading={actionLoading}>Confirm Attendance</Button>
        )}
      </Group>
      <RosterGrid eventData={eventData} canManageAttendance={canManageAttendance} onManualEdit={onManualEdit} />
    </Card>
  );
}
