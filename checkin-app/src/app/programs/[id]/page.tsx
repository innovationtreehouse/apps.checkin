"use client";

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Card, Center, Container, Group, Text, Title } from '@mantine/core';
import { LoadError } from '@checkin/component-ui';
import { PageLoader } from "@/components/ui/PageLoader";
import { useProgramEnrollment } from './useProgramEnrollment';
import ProgramDetailsCard from './ProgramDetailsCard';
import EnrollmentPicker from './EnrollmentPicker';

export default function ProgramEnrollmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const {
    session, status, program, programLoad, successMessage, startEnrollmentProcess, signInToProgram, showEnrollmentSelection, ageUnknown, picker,
  } = useProgramEnrollment(id);

  if ((!program && (programLoad.loading || programLoad.retrying)) || status === "loading") {
    return <PageLoader />;
  }

  if (!program && programLoad.error && programLoad.status !== 404) return (
    <Container size="sm" py="xl">
      <LoadError what="this program" message={programLoad.error} onRetry={programLoad.reload} />
    </Container>
  );

  if (!program) return (
    <Container size="sm" py="xl">
      <Card withBorder radius="md" padding="xl" ta="center">
        <Title order={3}>{programLoad.status === 404 ? "Program not found." : "Not Found"}</Title>
        <Group justify="center" mt="lg">
          <Button onClick={() => router.push('/programs')}>Back to Directory</Button>
          {/* A members-only program reads as not found until the visitor signs in. */}
          {!session && <Button variant="default" onClick={signInToProgram}>Sign in</Button>}
        </Group>
      </Card>
    </Container>
  );

  const user = session?.user;
  const canManage = !!(session && (user?.isSysadmin || user?.isBoardMember || user?.isFinance || user?.id === program.leadMentorId));

  // My household's already-enrolled members — shown so a returning parent doesn't
  // re-attempt an enrollment that would 409. name/householdId are public tier, so
  // they survive the stripper; no extra household fetch needed here.
  const myEnrolled = (program.participants ?? [])
    .filter(p => p.person && (p.personId === user?.id || (user?.householdId != null && p.person.householdId === user.householdId)))
    .map(p => ({
      name: p.personId === user?.id ? (p.person?.name || 'You') : (p.person?.name || 'Household member'),
      // Only a household lead receives status (lib/programs/paymentVisibility).
      unpaid: p.status === 'PENDING',
    }));
  const hasPrice = !!(program.orgMemberPriceCents || program.nonOrgMemberPriceCents);
  // Only a known adult is shown a payment obligation, action, or status — their
  // own or their household's. A youth is told a lead must act; an unknown age is
  // sent to the intake panel to add a date of birth, which settles the view.
  const viewerIsYouth = user?.ageBand === 'youth';
  const seesPayment = user?.ageBand === 'adult';

  const ageRange = program.minAge !== null && program.maxAge !== null ? `ages ${program.minAge}–${program.maxAge}`
    : program.minAge !== null ? `ages ${program.minAge} and up`
    : program.maxAge !== null ? `ages ${program.maxAge} and under` : null;

  const enrolledCount = program._count?.participants ?? program.participants?.length ?? 0;
  const isFull = program.maxParticipants != null && enrolledCount >= program.maxParticipants;
  // The server decides whether a new claim would be refused; full wins over phase.
  const closedBy = program.enrollmentClosedBy;
  const isClosed = closedBy !== null;
  const closedReason = closedBy === 'FULL' ? 'Full'
    : closedBy === 'SALE_ENDED' ? 'Sales ended'
    : closedBy === null ? null
    : program.phase === 'RUNNING' ? 'Running'
    : program.phase === 'UPCOMING' ? 'Upcoming'
    : program.phase === 'FINISHED' ? 'Ended'
    : null;
  // An ended program offers no payment; the board settles a late one by hand.
  const hasEnded = program.phase === 'FINISHED';
  // Until then a household with an unpaid claim keeps its way to pay however enrollment closed; the server refuses only new claims.
  const canResume = seesPayment && !hasEnded && myEnrolled.some((m) => m.unpaid);
  const closedSuffix = closedReason && <Text component="span" c="white"> ({closedReason})</Text>;

  return (
    <Container size="md" pb="md">
      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" align="center" wrap="wrap" mb="lg">
          <Title order={1}>{program.name}</Title>
          <Group>
            {canManage && (
              <Button variant="light" onClick={() => router.push(`/program-ops/programs/${program.id}`)}>
                Manage Program
              </Button>
            )}
            <Button variant="default" onClick={() => router.back()}>← Back</Button>
          </Group>
        </Group>

        <ProgramDetailsCard
          program={program}
          ageRange={ageRange}
          enrolledCount={enrolledCount}
          isFull={isFull}
          myEnrolled={myEnrolled}
          seesPayment={seesPayment}
          isClosed={isClosed}
          hasEnded={hasEnded}
          onPayNow={startEnrollmentProcess}
        />

        {/* A current member whose membership doesn't cover this program's whole
            run doesn't get member pricing on it — the discount-code fetch's
            `reason` reinforces this at checkout time, so it isn't repeated here. */}
        {program.viewerIsMember === true && program.viewerMemberPricingEligible === false && (
          <Alert color="yellow" variant="light" mb="lg">
            Your membership ends before this program finishes, so member pricing doesn&apos;t apply — renew your membership first to enroll at the member price.
          </Alert>
        )}

        {successMessage && <Alert mb="lg">{successMessage}</Alert>}

        <Center mt="xl">
          {!showEnrollmentSelection ? (
            <Group justify="center" wrap="wrap">
              {session ? (
                <Button size="md" onClick={startEnrollmentProcess} disabled={(isClosed && !canResume && !ageUnknown) || viewerIsYouth}>
                  {/* A payment-pending household reads "Continue enrollment" — the
                      button resumes their checkout (see the pending picker state),
                      it doesn't start a new one. An unknown age is asked for a
                      date of birth first. A youth is told who may act instead,
                      which holds whether or not the program is priced. */}
                  {canResume ? "Continue enrollment"
                    : ageUnknown ? "Add your date of birth to continue"
                    : isClosed ? <>Enrollment Closed{closedSuffix}</>
                    : viewerIsYouth ? "A household lead must enroll you"
                    : "Enroll"}
                </Button>
              ) : (
                // Auth-first: route through /signin (which picks Google vs. the
                // offline dev picker by env) BEFORE any intake, so account
                // existence is resolved by NextAuth, never leaked by a public API
                // response. First-time users are then filled in by the intake
                // panel below.
                <Button size="md" onClick={signInToProgram} disabled={isClosed}>
                  {isClosed ? <>Enrollment Closed{closedSuffix}</> : "Sign in to enroll"}
                </Button>
              )}
            </Group>
          ) : (
            <EnrollmentPicker
              ageGated={program.minAge !== null || program.maxAge !== null}
              ageRange={ageRange}
              hasPrice={hasPrice}
              isClosed={isClosed && !canResume}
              seesPayment={seesPayment}
              controls={picker}
            />
          )}
        </Center>
      </Card>
    </Container>
  );
}
