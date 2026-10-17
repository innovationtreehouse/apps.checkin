"use client";

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Button, Group, Table, Text, Title } from '@mantine/core';
import { useOrgTime } from '@/components/TimezoneProvider';

type ProgramEvent = { id: number; name: string; startAt: string; endAt: string; attendanceConfirmedAt: string | null };

export function ProgramEventsTab({ programId, events }: { programId: number; events: ProgramEvent[] }) {
  const { formatDateTime } = useOrgTime();
  const router = useRouter();

  return (
    <>
      <Group justify="space-between" align="center" mb="md">
        <Title order={4}>Events ({events.length})</Title>
        <Button variant="light" onClick={() => router.push(`/program-ops/sessions/new?programId=${programId}`)}>+ Schedule Session(s)</Button>
      </Group>
      <Table.ScrollContainer minWidth={500}>
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Event Name</Table.Th>
              <Table.Th>Start Time</Table.Th>
              <Table.Th ta="right">Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {events.map(ev => {
              const isPastEvent = new Date(ev.endAt) < new Date();
              const needsConfirmation = isPastEvent && !ev.attendanceConfirmedAt;
              return (
                <Table.Tr key={ev.id}>
                  <Table.Td fw={500}>{ev.name}</Table.Td>
                  <Table.Td c="dimmed">{formatDateTime(ev.startAt)}</Table.Td>
                  <Table.Td ta="right">
                    {needsConfirmation ? (
                      <Button component={Link} href={`/program-ops/sessions/${ev.id}`} size="compact-xs" color="yellow" variant="light">Confirm Attendance</Button>
                    ) : (
                      <Anchor component={Link} href={`/program-ops/sessions/${ev.id}`}>{isPastEvent ? 'Attendance →' : 'Edit Event →'}</Anchor>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            })}
            {events.length === 0 && (
              <Table.Tr><Table.Td colSpan={3} ta="center"><Text c="dimmed" py="md">No events scheduled.</Text></Table.Td></Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </>
  );
}
