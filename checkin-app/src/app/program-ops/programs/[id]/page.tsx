"use client";

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRequireRole } from '@/hooks/useRequireRole';
import { Badge, Button, Card, Container, Group, Tabs, Title } from '@mantine/core';
import { LoadError } from '@checkin/component-ui';
import { useLoad } from '@/lib/api';
import { ScrollableTabsList } from '@/components/ui/ScrollableTabsList';
import { ProgramGeneralTab } from './ProgramGeneralTab';
import { ProgramRosterTab } from './ProgramRosterTab';
import { ProgramEventsTab } from './ProgramEventsTab';
import { useProgramStoreClosed } from '../../useProgramStoreClosed';

import { PageLoader } from "@/components/ui/PageLoader";
import { useMembershipYearBoundary } from '../../ProgramYearField';
export type ProgramDetail = {
  id: number;
  name: string;
  startAt: string;
  endAt: string;
  appliesToYear: number;
  offSaleAt: string | null;
  leadMentorId: number | null;
  phase: string;
  enrollmentStatus: string;
  minAge: number | null;
  maxAge: number | null;
  maxParticipants: number | null;
  orgMemberOnly: boolean;
  publiclyVisible: boolean;
  announceOnOpen: boolean;
  participants: {
    personId: number;
    status: string;
    pendingSince: string | null;
    // Age in whole years at the program's start; null when the date of birth is unknown.
    age?: number | null;
    person: {
      name: string | null;
      email: string;
      // Present for an adult participant only, and only to a viewer granted it.
      phone?: string | null;
      householdId: number;
      // householdMembers is the household's leads (the parents) only. Contact
      // fields are optional because the response stripper drops them for a
      // viewer without the grant.
      household?: {
        householdMembers?: { id: number; name: string | null; email?: string | null; phone?: string | null }[];
        emergencyContacts: { id: number; name: string; phone: string; relationship: string | null }[];
      } | null;
    };
  }[];
  volunteers: { personId: number; isCore: boolean; person: { name: string | null; email: string } }[];
  events: { id: number; name: string; startAt: string; endAt: string; attendanceConfirmedAt: string | null }[];
  leadMentor: { name: string | null; email: string } | null;
  orgMemberPriceCents: number | null;
  nonOrgMemberPriceCents: number | null;
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
  claimantShopifyVariantId?: string | null;
};

export type ParticipantOption = { id: number; name: string | null; email: string; leaderIneligibility?: string | null };
// The eligible-participants search returns names only, plus the program's age-fit label.
export type EligibleOption = { id: number; name: string | null; ageWarning: string | null };

const PHASE_BADGE: Record<string, { label: string; color: string }> = {
  PLANNING: { label: 'Planning', color: 'gray' },
  UPCOMING: { label: 'Upcoming', color: 'yellow' },
  RUNNING: { label: 'Running', color: 'cyan' },
  FINISHED: { label: 'Finished', color: 'teal' },
};

export default function ProgramDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user: sessionUser, loading: authLoading, ready } = useRequireRole([]);
  const router = useRouter();

  const { data: program, error: loadError, status: loadStatus, reload } = useLoad<ProgramDetail>(ready ? `/api/programs/${id}` : null);

  const [activeTab, setActiveTab] = useState<'general' | 'roster' | 'events'>('general');

  const yearBoundary = useMembershipYearBoundary(!!(sessionUser?.isSysadmin || sessionUser?.isBoardMember));
  const storeClosed = useProgramStoreClosed(!!(sessionUser?.isSysadmin || sessionUser?.isBoardMember));

  if (authLoading) {
    return <PageLoader />;
  }

  if (!ready) return null;

  if (!program) {
    if (!loadError) return <PageLoader />;
    return (
      <Container size="sm" py="xl">
        <Card withBorder radius="md" padding="xl" ta="center">
          {loadStatus === 404
            ? <Title order={3}>Program not found.</Title>
            : <LoadError what="the program" message={loadError} onRetry={reload} />}
          <Group justify="center" mt="lg"><Button onClick={() => router.push('/program-ops/programs')}>Back</Button></Group>
        </Card>
      </Container>
    );
  }

  // Ownership gate stays inline — it needs the loaded program (lead-mentor id)
  // to decide, which useRequireRole (a static role gate) can't express.
  const user = sessionUser as unknown as { id: number; isSysadmin?: boolean; isBoardMember?: boolean; isFinance?: boolean };
  const isAuthorized = program.leadMentorId === user?.id || user?.isSysadmin || user?.isBoardMember || user?.isFinance;

  if (!isAuthorized) {
    return (
      <Container size="sm" py="xl">
        <Card withBorder radius="md" padding="xl" ta="center">
          <Title order={3}>Forbidden: Not authorized to manage this program.</Title>
          <Group justify="center" mt="lg"><Button onClick={() => router.push('/program-ops/programs')}>Back</Button></Group>
        </Card>
      </Container>
    );
  }

  const isSysAdminOrBoard = user?.isSysadmin || user?.isBoardMember;
  // Finance reaches only the roster, to enroll places paid outside the store.
  const rosterOnly = !isSysAdminOrBoard && program.leadMentorId !== user?.id;
  const tab = rosterOnly ? 'roster' : activeTab;
  const phaseBadge = PHASE_BADGE[program.phase];

  return (
    <Container size="lg" pb="md">
      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" align="center" wrap="wrap" mb="lg">
          <Group align="center" gap="sm">
            <Title order={1}>{program.name}</Title>
            {phaseBadge && <Badge color={phaseBadge.color} variant="light" size="lg">{phaseBadge.label}</Badge>}
          </Group>
          <Button variant="default" onClick={() => router.push('/program-ops/programs')}>← Back to Programs</Button>
        </Group>

        {loadError && <LoadError what="the program" message={loadError} onRetry={reload} />}

        <Tabs value={tab} onChange={(v) => setActiveTab((v as typeof activeTab) ?? 'general')}>
          <ScrollableTabsList mb="lg">
            {!rosterOnly && <Tabs.Tab value="general">General</Tabs.Tab>}
            <Tabs.Tab value="roster">Roster</Tabs.Tab>
            {!rosterOnly && <Tabs.Tab value="events">Events</Tabs.Tab>}
          </ScrollableTabsList>

          {/* GENERAL */}
          {!rosterOnly && <Tabs.Panel value="general">
            <ProgramGeneralTab
              programId={id}
              program={program}
              isBoardMember={!!user?.isBoardMember}
              isSysAdminOrBoard={!!isSysAdminOrBoard}
              yearBoundary={yearBoundary}
              storeClosed={storeClosed}
              reload={reload}
            />
          </Tabs.Panel>}

          {/* ROSTER */}
          <Tabs.Panel value="roster">
            <ProgramRosterTab
              programId={id}
              program={program}
              isSysAdminOrBoard={!!isSysAdminOrBoard}
              isBoardMember={!!user?.isBoardMember}
              canEnrollByHand={!!(user?.isBoardMember || user?.isFinance)}
              viewerHouseholdId={sessionUser?.householdId ?? null}
              fetchProgram={reload}
            />
          </Tabs.Panel>

          {/* EVENTS */}
          {!rosterOnly && <Tabs.Panel value="events">
            <ProgramEventsTab programId={program.id} events={program.events} />
          </Tabs.Panel>}
        </Tabs>
      </Card>
    </Container>
  );
}