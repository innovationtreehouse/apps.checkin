"use client";

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, Checkbox, Divider, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { formatDateOnly } from '@/lib/time';
import { PageContainer } from '@/components/ui/PageContainer';

import { PageLoader } from "@/components/ui/PageLoader";
type ProgramSummary = {
  id: number;
  name: string;
  startAt: string | null;
  endAt: string | null;
  orgMemberOnly: boolean;
  phase: string;
  enrollmentStatus: string;
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
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [loading, setLoading] = useState(true);
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
  const [message, setMessage] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);

  const isAuthorized = session && (session.user?.isSysadmin || session.user?.isBoardMember);

  useEffect(() => {
    const fetchPrograms = async () => {
      setLoading(true);
      try {
        const query = (isAuthorized && !activeOnly) ? '' : '?active=true';
        const res = await fetch(`/api/programs${query}`);
        if (res.ok) {
          const data = await res.json();
          setPrograms(data);
        } else {
          setMessage("Failed to load program directory.");
        }
      } catch {
        notifications.show({ color: "red", message: "Network error loading programs.", autoClose: false });
      } finally {
        setLoading(false);
      }
    };

    fetchPrograms();
  }, [activeOnly, isAuthorized]);

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
            <Button component={Link} href="/program-ops/new" variant="light">
              + New Program
            </Button>
          </Group>
        )}
      </Group>

      {message && <Alert color="red">{message}</Alert>}

      {programs.length === 0 ? (
        <Card withBorder radius="md" padding="xl" ta="center">
          <Text c="dimmed">No active programs currently available. Check back soon!</Text>
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          {programs.map((program) => {
            const isOwner = session && session.user?.id === program.leadMentorId;
            const canManage = session && (session.user?.isSysadmin || session.user?.isBoardMember || isOwner);
            return (
              <Card key={program.id} withBorder radius="md" padding="lg">
                <Group justify="space-between" align="flex-start" mb="sm">
                  <Title order={4}>{program.name}</Title>
                  <Group gap={4}>
                    {isOwner && <Badge>Yours</Badge>}
                    {program.orgMemberOnly && <Badge color="grape" variant="light">Treehouse Members Only</Badge>}
                    {program.phase === 'PLANNING' && <Badge color="yellow" variant="light">Planning</Badge>}
                    {program.enrollmentStatus === 'CLOSED' && <Badge color="red" variant="light">Closed</Badge>}
                  </Group>
                </Group>

                <Text c="dimmed" style={{ flex: 1 }} mb="md">
                  {program.startAt ? formatDateOnly(program.startAt) : 'Start Date TBD'}
                  {program.endAt ? ` - ${formatDateOnly(program.endAt)}` : ' (Ongoing)'}
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

