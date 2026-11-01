"use client";

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Badge, Button, Card, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { notifications } from "@mantine/notifications";
import { LoadError } from "@checkin/component-ui";
import { useOrgTime } from '@/components/TimezoneProvider';
import { useLoad } from "@/lib/api";
import { useSeedForm } from "@/hooks/useSeedForm";
import type { RSVPStatus } from '@/types/rsvp';

import { PageLoader } from "@/components/ui/PageLoader";
// No NO_RESPONSE button — that's the absence of a choice, not a pickable one.
type RsvpStatus = Exclude<RSVPStatus, "NO_RESPONSE">;

// One row per (event, household member) — a lead sees a card per family member.
type EventData = {
  id: number;
  name: string;
  description: string | null;
  startAt: string;
  endAt: string;
  program: { name: string } | null;
  participant: { id: number; name: string | null };
  rsvp: RsvpStatus | null;
  isVolunteer: boolean;
  isLead: boolean;
};

// Group (event, member) rows into one bucket per event, preserving first-seen order.
function groupByEvent(events: EventData[]): EventData[][] {
  const byId = new Map<number, EventData[]>();
  for (const ev of events) {
    const rows = byId.get(ev.id);
    if (rows) rows.push(ev);
    else byId.set(ev.id, [ev]);
  }
  return [...byId.values()];
}

const RSVP_OPTIONS: { status: RsvpStatus; label: string; color: string }[] = [
  { status: 'ATTENDING', label: 'Yes', color: 'treehouseGreen' },
  { status: 'MAYBE', label: 'Maybe', color: 'yellow' },
  { status: 'NOT_ATTENDING', label: 'No', color: 'red' },
];

export default function ParticipantEventsDashboard() {
  const { formatDateTime, formatTime } = useOrgTime();
  const { data: session, status } = useSession();
  const router = useRouter();
  const [events, setEvents] = useState<EventData[]>([]);
  // Counts RSVPs still saving; a refetch landing meanwhile must not undo them.
  const [saving, setSaving] = useState(0);
  const { data, error, reload } = useLoad<EventData[]>(status === "authenticated" ? '/api/events/mine' : null);
  useSeedForm(data, saving > 0, setEvents);

  useEffect(() => {
    if (status === "unauthenticated") router.push('/');
  }, [status, router]);

  const handleRSVP = async (eventId: number, participantId: number, newStatus: RsvpStatus) => {
    const setRsvp = (rsvp: RsvpStatus | null) => setEvents(prev => prev.map(ev =>
      ev.id === eventId && ev.participant.id === participantId ? { ...ev, rsvp } : ev
    ));
    const previous = events.find(ev => ev.id === eventId && ev.participant.id === participantId)?.rsvp ?? null;

    // Optimistic update — only the targeted member's card.
    setRsvp(newStatus);
    setSaving((n) => n + 1);

    try {
      const res = await fetch(`/api/events/${eventId}/rsvp`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, participantId })
      });
      if (!res.ok) {
        // Non-OK doesn't throw — revert the optimistic update and surface the error.
        const body = await res.json().catch(() => ({}));
        setRsvp(previous);
        notifications.show({ color: "red", message: body.error || "Failed to update RSVP.", autoClose: false });
      }
    } catch {
      setRsvp(previous);
    } finally {
      setSaving((n) => n - 1);
      reload();
    }
  };

  // A household lead sees every member's events, so label whose each card is.
  const showMembers = !!session?.user.householdLead;

  if (status === "loading" || (!data && !error)) {
    return <PageLoader />;
  }

  return (
    <Stack>
      <Title order={1}>My Upcoming Events</Title>

      {error ? (
        <LoadError what="your events" message={error} onRetry={reload} />
      ) : events.length === 0 ? (
        <Card withBorder radius="md" padding="xl" ta="center">
          <Title order={3}>No Upcoming Events</Title>
          <Text c="dimmed" mt="sm">
            You have no scheduled events for the programs you take part in.
          </Text>
          <Group justify="center" mt="lg">
            <Button component={Link} href="/programs" variant="light">Browse Programs</Button>
          </Group>
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          {groupByEvent(events).map((rows) => {
            const ev = rows[0];
            const startStr = formatDateTime(ev.startAt, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const endStr = formatTime(ev.endAt, { hour: '2-digit', minute: '2-digit' });
            // Multi-member cards must always show whose RSVP is whose, even for non-leads.
            const labelMembers = showMembers || rows.length > 1;

            return (
              <Card key={ev.id} withBorder radius="md" padding="lg">
                <Stack gap="sm" h="100%">
                  <Group justify="space-between" wrap="nowrap" align="flex-start">
                    <div>
                      {ev.program && (
                        <Text size="xs" c="cyan" fw={600} tt="uppercase">{ev.program.name}</Text>
                      )}
                      <Title order={4}>{ev.name}</Title>
                      <Text size="sm" c="dimmed">📅 {startStr} – {endStr}</Text>
                    </div>
                    <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                      {rows.some((r) => r.isLead) && (
                        <Badge color="indigo" variant="light">Program Leader</Badge>
                      )}
                      {rows.some((r) => r.isVolunteer) && (
                        <Badge color="grape" variant="light">Volunteer</Badge>
                      )}
                    </Group>
                  </Group>

                  {ev.description && (
                    <Text size="sm" lineClamp={2}>{ev.description}</Text>
                  )}

                  <Stack gap="xs" style={{ marginTop: 'auto' }}>
                    {rows.map((member) => (
                      <div key={member.participant.id}>
                        {labelMembers ? (
                          <Badge variant="light" mb={4}>{member.participant.name ?? 'Member'}</Badge>
                        ) : (
                          <Text size="sm" c="dimmed" mb={4}>RSVP Status:</Text>
                        )}
                        <Button.Group>
                          {RSVP_OPTIONS.map((opt) => (
                            <Button
                              key={opt.status}
                              fullWidth
                              variant={member.rsvp === opt.status ? 'filled' : 'default'}
                              color={opt.color}
                              onClick={() => handleRSVP(ev.id, member.participant.id, opt.status)}
                            >
                              {opt.label}
                            </Button>
                          ))}
                        </Button.Group>
                      </div>
                    ))}
                  </Stack>
                </Stack>
              </Card>
            );
          })}
        </SimpleGrid>
      )}
    </Stack>
  );
}
