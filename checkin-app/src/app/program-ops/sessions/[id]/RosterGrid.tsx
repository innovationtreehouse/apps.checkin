"use client";

import { Badge, Button, Group, Table, Text } from '@mantine/core';
import type { EventData, RosterMember, Visit } from './eventDetail';

export function RosterGrid({ eventData, canManageAttendance, onManualEdit }: {
  eventData: EventData;
  canManageAttendance: boolean;
  onManualEdit: (member: RosterMember, visit: Visit | undefined) => void;
}) {
  if (!eventData.program) return null;

  const allRoster = [
    ...eventData.program.volunteers.map(v => ({ ...v, role: v.isCore ? 'Core Volunteer' : 'Volunteer' })),
    ...eventData.program.participants.map(p => ({ ...p, role: 'Participant' }))
  ];

  const ROLE_RANK: Record<string, number> = { 'Core Volunteer': 1, 'Volunteer': 2, 'Participant': 3 };

  allRoster.sort((a, b) => {
    if (ROLE_RANK[a.role] !== ROLE_RANK[b.role]) return ROLE_RANK[a.role] - ROLE_RANK[b.role];
    return (a.person.name || "").localeCompare(b.person.name || "");
  });

  return (
    <Table.ScrollContainer minWidth={600} mt="md">
      <Table verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th>Role</Table.Th>
            <Table.Th>Status / Time</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {allRoster.map((member) => {
            const visit = eventData.visits.find(v => v.personId === member.personId);
            let statusEl;
            if (visit) {
              const arriveTime = new Date(visit.arrivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              const leaveTime = visit.departedAt ? new Date(visit.departedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Still Here';
              statusEl = <Text component="span" c="green">Arrived: {arriveTime} {visit.departedAt ? `| Left: ${leaveTime}` : ''}</Text>;
            } else {
              statusEl = <Text component="span" c="red">Absent</Text>;
            }

            return (
              <Table.Tr key={`${member.role}-${member.personId}`}>
                <Table.Td>
                  <Text fw={500}>{member.person.name || 'Unnamed'}</Text>
                  <Text size="xs" c="dimmed">{member.person.email}</Text>
                </Table.Td>
                <Table.Td>
                  <Badge color={member.role === 'Participant' ? 'cyan' : 'yellow'} variant="light">{member.role}</Badge>
                </Table.Td>
                <Table.Td>
                  <Group justify="space-between" wrap="nowrap">
                    {statusEl}
                    {canManageAttendance && (
                      <Button size="compact-xs" variant="light" onClick={() => onManualEdit(member, visit)}>
                        Manual Edit
                      </Button>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            );
          })}
          {allRoster.length === 0 && (
            <Table.Tr><Table.Td colSpan={3} ta="center"><Text c="dimmed" py="md">No roster found for this program.</Text></Table.Td></Table.Tr>
          )}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
