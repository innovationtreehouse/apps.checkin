"use client";

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { Badge, Button, Card, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconCalendarCheck, IconSearch } from '@tabler/icons-react';
import { useTodoCounts } from '@/hooks/useTodoCounts';
import type { TodoCounts } from '@/lib/nav/todoCounts';

type LedProgram = NonNullable<TodoCounts['lead']>['programs'][number];

/**
 * Attendance-inbox subtab of staff "My Programs". Lists the programs the caller
 * runs and surfaces the same pending attendance the post-event email targets,
 * deep-linking to the existing confirm screen. Pure navigation + surfacing.
 *
 * Section chrome (title, subtabs) and the lead-gate / loading state live in
 * layout.tsx; this renders only the inbox content.
 */
export default function MyProgramsHome() {
  const { status } = useSession();
  const counts = useTodoCounts(status === 'authenticated');
  const [filter, setFilter] = useState('');

  const programs = counts?.lead?.programs ?? [];
  if (programs.length === 0) return null; // layout shows loader / redirects non-leads

  if (programs.length === 1) return <ProgramSection program={programs[0]} />;

  // ponytail: filter over the names already in the payload (program + session).
  // Participant/volunteer names aren't fetched here — add to lib/nav/todoCounts.ts to match those.
  const q = filter.trim().toLowerCase();
  const shown = q
    ? programs.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        p.upcoming.some((s) => s.name.toLowerCase().includes(q)) ||
        p.pending.some((i) => i.label.toLowerCase().includes(q)))
    : programs;

  return (
    <Stack>
      <TextInput
        placeholder="Filter by program or session name"
        leftSection={<IconSearch size={16} />}
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
        maw={360}
      />
      {shown.length === 0 ? (
        <Text c="dimmed" size="sm">No programs match “{filter}”.</Text>
      ) : (
        shown.map((p) => <ProgramSection key={p.id} program={p} />)
      )}
    </Stack>
  );
}

const fmtSession = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" });

type RsvpTally = LedProgram['upcoming'][number]['participants'];

function RsvpRow({ label, tally }: { label: string; tally: RsvpTally }) {
  return (
    <Group justify="space-between" wrap="nowrap" mt={4}>
      <Text size="xs" c="dimmed" w={90}>{label}</Text>
      <Group gap="xs" wrap="nowrap">
        <Badge variant="light">Yes {tally.yes}</Badge>
        <Badge color="yellow" variant="light">Maybe {tally.maybe}</Badge>
        <Badge color="red" variant="light">No {tally.no}</Badge>
      </Group>
    </Group>
  );
}

function ProgramSection({ program }: { program: LedProgram }) {
  return (
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" align="flex-start" mb="sm">
        <Title order={3}>{program.name}</Title>
        <Button component={Link} href={`/program-ops/programs/${program.id}`} variant="subtle" size="xs">
          Manage
        </Button>
      </Group>

      <Text ta="center" fw={600} mb="md">
        Total Enrolled: {program.totalEnrolled}
      </Text>

      {program.upcoming.length > 0 && (
        <Stack gap="sm" mb="md">
          <Text fw={600} size="sm">Next sessions</Text>
          {program.upcoming.map((s) => (
            <div key={s.eventId}>
              <Text size="sm" fw={500}>{fmtSession(s.startAt)} — {s.name}</Text>
              <RsvpRow label="Participants" tally={s.participants} />
              <RsvpRow label="Volunteers" tally={s.volunteers} />
            </div>
          ))}
        </Stack>
      )}

      {program.pending.length === 0 ? (
        <Text c="dimmed" size="sm">No attendance to confirm.</Text>
      ) : (
        <Stack gap="xs">
          <Text fw={600} size="sm">Attendance to confirm</Text>
          {program.pending.map((item) => (
            <Button
              key={item.key}
              component={Link}
              href={item.href}
              variant="light"
              color="treehouseGreen"
              justify="space-between"
              leftSection={<IconCalendarCheck size={16} />}
              fullWidth
            >
              {item.label}
            </Button>
          ))}
        </Stack>
      )}
    </Card>
  );
}
