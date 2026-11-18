"use client";

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { Badge, Button, Card, Checkbox, Divider, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { LoadError } from '@checkin/component-ui';
import { useLoad } from '@/lib/api';
import { formatDateOnly } from '@/lib/time';
import { PageContainer } from '@/components/ui/PageContainer';
import type { EnrollmentClosedBy } from '@/lib/programs/saleState';

import { PageLoader } from "@/components/ui/PageLoader";
type ProgramSummary = {
  id: number;
  name: string;
  startAt: string;
  endAt: string;
  orgMemberOnly: boolean;
  phase: string;
  enrollmentStatus: string;
  // Server-derived: why a new claim would be refused, null when open.
  enrollmentClosedBy: EnrollmentClosedBy | null;
  leadMentorId: number | null;
  maxParticipants: number | null;
  _count?: {
    participants: number;
    volunteers: number;
    events: number;
  };
};

export default function PublicProgramsDirectory() {
  const { data: session } = useSession();
  const [activeOnly, setActiveOnly] = useState(true);
  const isAuthorized = session && (session.user?.isSysadmin || session.user?.isBoardMember);
  const { data, error, reload } = useLoad<ProgramSummary[]>(`/api/programs${(isAuthorized && !activeOnly) ? '' : '?active=true'}`);
  const programs = data ?? [];
  // Retries keep data and error both null, so they count as loading, never as an empty directory.
  const loading = !data && !error;
  // A load that outlives a normal round trip is almost always the system waking
  // (the retry extension rides it out server-side, up to ~45s) — tell the user
  // something generic is happening rather than leaving a bare spinner. Same
  // tone as the global DbWakeNotice banner.
  const [slowLoad, setSlowLoad] = useState(false);
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setSlowLoad(true), 4000);
    return () => { clearTimeout(t); setSlowLoad(false); };
  }, [loading]);

  if (loading) {
    return (
      <Stack align="center" gap="sm" mt="xl">
        <PageLoader />
        {slowLoad && (
          <Text size="sm" c="dimmed" ta="center">
            Getting the system ready for you — this usually takes under a minute.
          </Text>
        )}
      </Stack>
    );
  }

  return (
    <PageContainer>
      <Stack>
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Title order={1}>Programs Directory</Title>
          <Text c="dimmed" mt="xs">
            Discover courses, certifications, and group activities at the Treehouse.
          </Text>
        </div>
        {isAuthorized && (
          <Group gap="lg" wrap="wrap">
            <Checkbox
              label="Show active only"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.currentTarget.checked)}
            />
            {session?.user?.isBoardMember && (
              <Button component={Link} href="/program-ops/new" variant="light">
                + New Program
              </Button>
            )}
          </Group>
        )}
      </Group>

      {error ? (
        <LoadError what="the program directory" message={error} onRetry={reload} />
      ) : programs.length === 0 ? (
        <Card withBorder radius="md" padding="xl" ta="center">
          <Text c="dimmed">No active programs currently available. Check back soon!</Text>
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          {programs.map((program) => {
            const isOwner = session && session.user?.id === program.leadMentorId;
            const canManage = session && (session.user?.isSysadmin || session.user?.isBoardMember || session.user?.isFinance || isOwner);
            return (
              <Card key={program.id} withBorder radius="md" padding="lg">
                <Group justify="space-between" align="flex-start" mb="sm">
                  <Title order={4}>{program.name}</Title>
                  <Group gap={4}>
                    {isOwner && <Badge>Yours</Badge>}
                    {program.orgMemberOnly && <Badge color="grape" variant="light">Treehouse Members Only</Badge>}
                    {program.phase === 'PLANNING' && <Badge color="yellow" variant="light">Planning</Badge>}
                    {program.enrollmentClosedBy && <Badge color="red" variant="light">Closed</Badge>}
                  </Group>
                </Group>

                <Text c="dimmed" style={{ flex: 1 }} mb="md">
                  {formatDateOnly(program.startAt)} - {formatDateOnly(program.endAt)}
                </Text>

                {/* Counts come live-only (never cached): while the system wakes,
                    the API omits them and the card simply skips this block. */}
                {program._count && (
                  <Card withBorder radius="sm" padding="xs" mb="md">
                    <Group justify="space-around">
                      <Stack gap={0} align="center">
                        <Text fw={700}>{program._count.participants}{program.maxParticipants != null && `/${program.maxParticipants}`}</Text>
                        <Text size="xs" c="dimmed">Enrolled</Text>
                      </Stack>
                      <Divider orientation="vertical" />
                      <Stack gap={0} align="center">
                        <Text fw={700}>{program._count.volunteers}</Text>
                        <Text size="xs" c="dimmed">Volunteers</Text>
                      </Stack>
                      <Divider orientation="vertical" />
                      <Stack gap={0} align="center">
                        <Text fw={700}>{program._count.events}</Text>
                        <Text size="xs" c="dimmed">Sessions</Text>
                      </Stack>
                    </Group>
                  </Card>
                )}

                <Stack gap="xs">
                  <Button component={Link} href={`/programs/${program.id}`} variant="light">
                    View details and enroll
                  </Button>
                  {canManage && (
                    <Button component={Link} href={`/program-ops/programs/${program.id}`} variant="light">
                      Manage
                    </Button>
                  )}
                </Stack>
              </Card>
            );
          })}
        </SimpleGrid>
      )}
      </Stack>
    </PageContainer>
  );
}

