"use client";

import { Anchor, Card, Divider, Stack, Text, Title } from '@mantine/core';
import { formatDateOnly } from '@/lib/time';
import { formatCents } from '@checkin/money';
import type { ProgramDetail } from './useProgramEnrollment';

/** The program's dates, enrollment state, eligibility, the household's enrollments and prices. */
export default function ProgramDetailsCard({ program, ageRange, enrolledCount, isFull, myEnrolled, viewerIsYouth, isClosed, onPayNow }: {
  program: ProgramDetail;
  ageRange: string | null;
  enrolledCount: number;
  isFull: boolean;
  myEnrolled: { name: string; unpaid: boolean }[];
  viewerIsYouth: boolean;
  isClosed: boolean;
  onPayNow: () => void;
}) {
  return (
    <Card withBorder radius="md" padding="lg" mb="lg">
      <Title order={4} c="dimmed" mb="md">Details</Title>
      <Stack gap="sm">
        {program.leadMentor && (
          <Text><strong>Lead Mentor:</strong> {program.leadMentor.name || 'Unnamed'}</Text>
        )}
        <Text><strong>Starts:</strong> {formatDateOnly(program.startAt)}</Text>
        <Text><strong>Ends:</strong> {formatDateOnly(program.endAt)}</Text>
        <Text>
          <strong>Enrollment:</strong>{' '}
          {program.enrollmentStatus === 'OPEN' ? <Text component="span" c="green">Open</Text> :
            program.enrollmentStatus === 'CLOSED' ? <Text component="span" c="red">Closed</Text> :
              program.enrollmentStatus === 'WHITELIST' ? <Text component="span" c="yellow">Invite Only</Text> :
                program.enrollmentStatus}
        </Text>
        {(ageRange || program.maxParticipants != null || program.orgMemberOnly) && (
          <>
            <Divider />
            {ageRange && <Text><strong>Age:</strong> {ageRange}</Text>}
            {program.maxParticipants != null && (
              <Text>
                <strong>Capacity:</strong> {enrolledCount}/{program.maxParticipants}
                {isFull && <Text component="span" c="red"> (Full)</Text>}
              </Text>
            )}
            {program.orgMemberOnly && <Text><strong>Eligibility:</strong> Treehouse Members only</Text>}
          </>
        )}
        {myEnrolled.length > 0 && !viewerIsYouth && (
          <>
            <Divider />
            <Text><strong>Already enrolled from your household:</strong></Text>
            {myEnrolled.map((m, i) => (
              <Text key={i} size="sm" c={m.unpaid ? 'yellow' : 'green'} ml="sm">
                {m.name} — {m.unpaid ? 'Enrolled, not paid yet' : 'Enrolled'}
                {m.unpaid && !isClosed && (
                  <>{' '}<Anchor component="button" size="sm" onClick={onPayNow}>Pay now</Anchor></>
                )}
              </Text>
            ))}
          </>
        )}
        {(program.orgMemberPriceCents !== null || program.nonOrgMemberPriceCents !== null) && (
          <>
            <Divider />
            {program.orgMemberPriceCents !== null && <Text><strong>Treehouse Member Price:</strong> {formatCents(program.orgMemberPriceCents)}</Text>}
            {program.nonOrgMemberPriceCents !== null && <Text><strong>Non-Member Price:</strong> {formatCents(program.nonOrgMemberPriceCents)}</Text>}
            {(!program.orgMemberPriceCents && !program.nonOrgMemberPriceCents) && <Text><strong>Cost:</strong> Free</Text>}
          </>
        )}
      </Stack>
    </Card>
  );
}
