"use client";

import { useRouter } from 'next/navigation';
import { Alert, Badge, Button, Group, Text } from '@mantine/core';
import { formatDateOnly } from '@/lib/time';
import { isMembershipLapsed } from '@/lib/membership/lapsed';
import { useOrgTime } from '@/components/TimezoneProvider';
import type { OrgMembership } from './household';

// An existing member — still ACTIVE with an open renewal, or already
// REVOKED/lapsed — gets the "Renew now" nudge; a household that never
// joined gets the join prompt; an ACTIVE member with nothing due gets
// the plain member badge.
export default function MembershipStatusAlert({ orgMembership, renewalDue, validUntil, viewerIsLead }: {
  orgMembership: OrgMembership | null | undefined;
  renewalDue: boolean;
  validUntil: string | null;
  viewerIsLead: boolean;
}) {
  const router = useRouter();
  const lapsed = isMembershipLapsed(validUntil, useOrgTime().today());

  if (renewalDue || orgMembership?.status === 'REVOKED') {
    return (
      <Alert color="blue" mb="lg">
        <Group justify="space-between" align="center" wrap="wrap">
          <Text c="dimmed">Renew your membership now!</Text>
          {viewerIsLead && <Button size="xs" fz={15} onClick={() => router.push('/membership')}>Renew!</Button>}
        </Group>
      </Alert>
    );
  }

  if (orgMembership?.status === 'ACTIVE') {
    return (
      <Alert mb="lg">
        <Group gap="xs" wrap="wrap">
          {/* memberSince is a calendar date at UTC midnight — getUTCFullYear, or a Jan 1 start reads as the prior year. */}
          <Text fw={600}>✓ Member{orgMembership.memberSince ? ` since ${new Date(orgMembership.memberSince).getUTCFullYear()}` : ''}</Text>
          {validUntil && (
            <Text c={lapsed ? 'red' : 'dimmed'} fw={lapsed ? 700 : undefined}>
              Valid through {formatDateOnly(validUntil, { year: 'numeric', month: 'short', day: 'numeric' })}{lapsed ? ' (lapsed)' : ''}
            </Text>
          )}
          {orgMembership.isVolunteerFamily && <Badge variant="light">Volunteer-only family</Badge>}
        </Group>
      </Alert>
    );
  }

  return (
    <Alert color="blue" mb="lg">
      <Group justify="space-between" align="center" wrap="wrap">
        <Text c="dimmed">Your household isn&apos;t a member yet.</Text>
        {viewerIsLead && <Button size="xs" fz={15} onClick={() => router.push('/membership')}>Join the Treehouse!</Button>}
      </Group>
    </Alert>
  );
}
