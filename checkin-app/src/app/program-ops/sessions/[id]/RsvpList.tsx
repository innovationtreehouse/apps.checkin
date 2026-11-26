"use client";

import { Badge, Card, Table, Text, Title } from '@mantine/core';
import type { RSVPStatus } from '@/types/rsvp';
import type { EventData } from './eventDetail';

const RSVP_BADGE: Record<RSVPStatus, { label: string; color: string }> = {
  ATTENDING: { label: 'Attending', color: 'treehouseGreen' },
  MAYBE: { label: 'Maybe', color: 'yellow' },
  NOT_ATTENDING: { label: 'Not attending', color: 'red' },
  NO_RESPONSE: { label: 'No response', color: 'gray' },
};

export function RsvpList({ eventData }: { eventData: EventData }) {
  if (!eventData.program) return null;

  const statusByParticipant = new Map(eventData.rsvps.map(r => [r.personId, r.status]));
  const roster = [
    ...eventData.program.volunteers.map(v => ({ ...v, role: v.isCore ? 'Core Volunteer' : 'Volunteer' })),
    ...eventData.program.participants.map(p => ({ ...p, role: 'Participant' })),
  ];
  const ROLE_RANK: Record<string, number> = { 'Core Volunteer': 1, 'Volunteer': 2, 'Participant': 3 };
  roster.sort((a, b) =>
    ROLE_RANK[a.role] !== ROLE_RANK[b.role]
      ? ROLE_RANK[a.role] - ROLE_RANK[b.role]
      : (a.person.name || "").localeCompare(b.person.name || "")
  );

  return (
    <Card withBorder radius="md" padding="lg" mb="lg">
      <Title order={4} mb="md">RSVPs</Title>
      <Table.ScrollContainer minWidth={400}>
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Role</Table.Th>
              <Table.Th>RSVP</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {roster.map((member) => {
              const badge = RSVP_BADGE[statusByParticipant.get(member.personId) ?? 'NO_RESPONSE'];
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
                    <Badge color={badge.color} variant="light">{badge.label}</Badge>
                  </Table.Td>
                </Table.Tr>
              );
            })}
            {roster.length === 0 && (
              <Table.Tr><Table.Td colSpan={3} ta="center"><Text c="dimmed" py="md">No roster found for this program.</Text></Table.Td></Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}
