"use client";

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Badge, Button, Card, Container, Group, SimpleGrid, Text, Title } from '@mantine/core';
import { LoadError } from '@checkin/component-ui';
import { useLoad } from '@/lib/api';
import { formatDateOnly } from '@/lib/time';

import { PageLoader } from "@/components/ui/PageLoader";
type UserProgram = {
  programId: number;
  personId: number;
  // Absent unless the viewer may see payment status (lib/programs/paymentVisibility).
  status?: 'PENDING' | 'ACTIVE';
  isPaymentPlanRequested?: boolean;
  person: { id: number; name: string | null };
  program: {
    id: number;
    name: string;
    startAt: string | null;
    endAt: string | null;
  };
};

// Payment pill: only a still-owed enrollment shows one — either the household's to
// pay (theme-primary, actionable) or waiting on finance to approve a payment plan
// (gray, not actionable — don't imply it's settled). The API sends no status to a
// viewer who may not see it, so youth and non-lead members get no pill.
function paymentPill(status: string | undefined, planRequested: boolean | undefined) {
  if (status !== 'PENDING') return null;
  return planRequested
    ? <Badge color="gray" variant="filled">Awaiting finance approval</Badge>
    : <Badge variant="filled">Not paid yet</Badge>;
}

export default function MyProgramsDashboard() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const { data: enrollments, error, reload } = useLoad<UserProgram[]>(status === "authenticated" ? '/api/programs/mine' : null);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push('/');
    }
  }, [status, router]);

  if (status === "loading") {
    return (
      <PageLoader />
    );
  }

  if (!session) return null;

  // A household lead sees the whole household, so label each card with whose
  // enrollment it is. A solo user only ever sees their own — no label needed.
  const showMembers = !!session.user.householdLead;

  return (
    <Container size="lg" pb="md">
      <Title order={1} mb="md">My Programs</Title>

      <Text c="dimmed" mb="lg">
        {showMembers
          ? 'Manage the programs you and your family are currently enrolled in.'
          : 'Manage the programs you are currently enrolled in.'}
      </Text>

      {error ? (
        <LoadError what="your programs" message={error} onRetry={reload} />
      ) : !enrollments ? (
        <PageLoader minHeight="30vh" />
      ) : enrollments.length === 0 ? (
        <Card withBorder radius="md" padding="xl" ta="center">
          <Text c="dimmed">You are not enrolled in any programs yet.</Text>
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          {enrollments.map(({ program, personId, person, status: enrollStatus, isPaymentPlanRequested }) => (
            <Card key={`${program.id}-${personId}`} withBorder radius="md" padding="lg">
              <Group gap="xs" mb="sm">
                {showMembers && (
                  <Badge variant="light">{person.name ?? 'Member'}</Badge>
                )}
                {paymentPill(enrollStatus, isPaymentPlanRequested)}
              </Group>
              <Title order={4} mb="sm">{program.name}</Title>
              <Text c="dimmed" style={{ flex: 1 }}>
                {formatDateOnly(program.startAt)} - {formatDateOnly(program.endAt)}
              </Text>
              {/* The program page's enroll button resumes the existing checkout. */}
              {enrollStatus === 'PENDING' && !isPaymentPlanRequested && (
                <Button component={Link} href={`/programs/${program.id}`} fullWidth mt="md">
                  Pay now
                </Button>
              )}
              <Button component={Link} href={`/programs/${program.id}`} variant="light" fullWidth mt="md">
                View Details
              </Button>
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Container>
  );
}
