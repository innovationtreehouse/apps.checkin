"use client";

import { use, useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Card, Center, Checkbox, Container, Divider, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { formatDateOnly } from '@/lib/time';
import { checkProgramAge } from '@/lib/programAge';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { formatCents } from '@inventory/money';
import { aggregateEnrollOutcomes, buildShopifyCheckoutUrl, type EnrollOutcome } from './enroll';
import FirstTimeIntakePanel from './FirstTimeIntakePanel';
import { useIsLocalInstance, useShopifyStoreDomain } from '@/components/EnvProvider';

import { PageLoader } from "@/components/ui/PageLoader";

type ProgramDetail = {
  id: number;
  name: string;
  startAt: string | null;
  endAt: string | null;
  leadMentorId: number | null;
  leadMentor?: { name: string | null; email: string } | null;
  // Absent for non-enrolled callers (route gates the roster); only their own
  // household's rows arrive when enrolled, which is all the "already enrolled"
  // check below needs.
  participants?: { personId: number, status?: string, person?: { name: string | null, householdId: number } }[];
  _count?: { participants?: number };
  phase: string;
  maxParticipants: number | null;
  enrollmentStatus: string;
  orgMemberPriceCents: number | null;
  nonOrgMemberPriceCents: number | null;
  // Single-pool model: the ONE variant for both tiers — member pricing comes
  // from a checkout-time discount code (see handleEnroll), not a separate variant.
  shopifyVariantId: string | null;
  minAge: number | null;
  maxAge: number | null;
  orgMemberOnly: boolean;
  // Server-computed, session callers only (route.ts) — undefined for an
  // anonymous caller or an older cached response. viewerMemberPricingEligible
  // is the pricing-relevant flag: a current member whose membership ends
  // before this program's coverage date (endAt, else startAt) is NOT eligible
  // for member pricing even though viewerIsMember is true.
  viewerIsMember?: boolean;
  viewerMemberPricingEligible?: boolean;
};

export default function ProgramEnrollmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: session, status, update: updateSession } = useSession();
  const router = useRouter();
  const isLocalInstance = useIsLocalInstance();
  const shopifyStoreDomain = useShopifyStoreDomain();

  const [program, setProgram] = useState<ProgramDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [message, setMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  const [showEnrollmentSelection, setShowEnrollmentSelection] = useState(false);
  const [householdMembers, setHouseholdMembers] = useState<{ id: number; name: string | null; dateOfBirth: string | null; isDeclaredAdult?: boolean }[]>([]);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<number[]>([]);
  const [loadingHousehold, setLoadingHousehold] = useState(false);
  // First-time gap: a freshly-signed-in user has a single-person household with
  // no enrollable participant and/or no emergency contact. When set, we offer the
  // intake panel instead of the dead-end "no eligible participants" alert.
  const [needsSetup, setNeedsSetup] = useState(false);
  const [showIntake, setShowIntake] = useState(false);

  const fetchProgram = useCallback(async () => {
    try {
      const res = await fetch(`/api/programs/${id}`);
      if (res.ok) {
        const data = await res.json();
        setProgram(data);
      } else if (res.status === 404) {
        setMessage("Program not found.");
      } else {
        setMessage("Failed to load program details.");
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchProgram();
  }, [fetchProgram]);

  // Why a member can't be enrolled. Shared by the default selection and the row
  // render so an ineligible member is never auto-selected and then POSTed (which
  // returned a confusing "Date of Birth is missing" for over-25 adults).
  const enrollBlock = (member: { id: number; dateOfBirth: string | null; isDeclaredAdult?: boolean }): { reason: 'enrolled' | 'pending' | 'awaiting' | 'age' | 'dob' | 'lead' | null; label: string } => {
    // Only a known adult may commit THEMSELVES to a program and its charge — the
    // enroll route refuses the rest, so the viewer's own row must never offer it.
    const viewer = session?.user;
    const selfBlocked = member.id === viewer?.id && viewer?.ageBand !== 'adult';
    const enrolledRow = (program?.participants ?? []).find(p => p.personId === member.id);
    // ACTIVE = paid/free/override (truly done) — locked. PENDING = payment still
    // owed: SELECTABLE, so the household can re-run checkout to finish paying
    // (the participants POST 409s and aggregateEnrollOutcomes folds a 409 back
    // into the checkout set — the same idempotent path as a double-click).
    if (enrolledRow) {
        if (enrolledRow.status === 'ACTIVE') return { reason: 'enrolled', label: 'Enrolled' };
        // A youth is never shown the payment behind a pending row — the resume
        // affordance is a checkout they may not reach. "Awaiting confirmation"
        // stays true whether or not the household ever pays.
        if (selfBlocked) {
            return viewer?.ageBand === 'youth'
                ? { reason: 'awaiting', label: 'Awaiting confirmation' }
                : { reason: 'dob', label: 'DOB missing' };
        }
        return { reason: 'pending', label: 'Payment pending — select to finish payment' };
    }
    if (!program) return { reason: null, label: '' };
    // Same eligibility rule as the enroll route: a declared over-25 adult clears
    // a youth minimum like "16 and up" without a DOB on file.
    const check = checkProgramAge(member, { minAge: program.minAge, maxAge: program.maxAge, asOf: program.startAt ?? undefined });
    if (!check.ok) return { reason: check.reason, label: check.label };
    // An unverifiable age keeps the 'dob' reason so the row still routes into the
    // intake panel, where a DOB or "over 25" can be set.
    if (selfBlocked) {
      return viewer?.ageBand === 'youth'
        ? { reason: 'lead', label: 'A household lead must enroll you' }
        : { reason: 'dob', label: 'DOB missing' };
    }
    return { reason: null, label: '' };
  };

  // Load the caller's household into the member-select, and decide whether they
  // still need first-time setup (no enrollable participant, or no valid emergency
  // contact). Shared by the initial "Enroll" click and the post-intake re-fetch.
  const populateHousehold = async () => {
    const currentUserId = session!.user.id;
    setLoadingHousehold(true);
    try {
      const res = await fetch(`/api/household`);
      let members: { id: number; name: string | null; dateOfBirth: string | null; isDeclaredAdult?: boolean }[] =
        [{ id: currentUserId, name: "Myself", dateOfBirth: null }];
      if (res.ok) {
        const data = await res.json();
        if (data.household?.householdMembers) members = data.household.householdMembers;
      }
      setHouseholdMembers(members);
      // Nobody is pre-checked: enrolling creates a PENDING row and a payment
      // obligation, so each participant must be an explicit click — including
      // the account holder, the easiest person to enroll by accident.
      setSelectedParticipantIds([]);

      const hasEnrollable = members.some((m) => { const r = enrollBlock(m).reason; return r === null || r === 'pending'; });
      // Emergency contact isn't in /api/household; probe the process-free intake
      // state for it. Fail open (treat as present) if the probe can't answer, so
      // a household with an enrollable member is never blocked by an EC hiccup.
      let hasValidEmergencyContact = true;
      try {
        const ir = await fetch(`/api/household/intake`);
        if (ir.ok) {
          const s = await ir.json();
          if (s && "prefill" in s) {
            const h = s.prefill?.household;
            hasValidEmergencyContact = !!(h?.emergencyContactName?.trim() && h?.emergencyContactPhone?.trim());
          }
        }
      } catch {
        /* fail open */
      }
      setNeedsSetup(!hasEnrollable || !hasValidEmergencyContact);
    } catch {
      const solo = { id: currentUserId, name: "Myself", dateOfBirth: null };
      setHouseholdMembers([solo]);
      // The solo entry carries no DOB, so an age-gated program blocks it and
      // leaves nothing to check. Offer household setup instead of a panel whose
      // only row is disabled.
      const reason = enrollBlock(solo).reason;
      setNeedsSetup(!(reason === null || reason === 'pending'));
    } finally {
      setLoadingHousehold(false);
    }
  };

  const startEnrollmentProcess = async () => {
    if (!session) {
      router.push('/');
      return;
    }
    setShowEnrollmentSelection(true);
    await populateHousehold();
  };

  // Back from the first-time intake panel: reload the household (the new child /
  // emergency contact are now saved) and drop into the normal member-select.
  const handleIntakeSaved = async () => {
    setShowIntake(false);
    // Intake just set a DOB or the over-25 flag. Re-stamp the session so the
    // ageBand claim reflects it NOW — the jwt callback refreshes on its own
    // schedule, and this is the one flow where waiting would leave a member who
    // just proved their age still blocked from enrolling.
    await updateSession();
    await populateHousehold();
  };

  const handleRequestPaymentPlan = async () => {
    if (!session) return router.push('/');
    if (selectedParticipantIds.length === 0) return;

    setEnrolling(true);
    setMessage("");

    const errors: string[] = [];
    let anyRequested = false;

    try {
      for (const participantId of selectedParticipantIds) {
        let res = await fetch(`/api/programs/${id}/participants`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ participantId })
        });

        if (!res.ok) {
          const data = await res.json();
          errors.push(data.error || "Failed to start enrollment.");
          continue;
        }

        res = await fetch(`/api/programs/${id}/request-payment-plan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ participantId })
        });

        if (res.ok) {
          anyRequested = true;
        } else {
          errors.push("Enrolled as pending, but failed to alert the Scholarship Review Team for one member. Please email them directly.");
        }
      }

      if (anyRequested) {
        notifications.show({ message: "Requested! Please check your email for communication from the Scholarship Review Team." });
        fetchProgram();
        notifyNavRefresh();
      }
      if (errors.length > 0) setMessage(errors.join(" "));
    } catch {
      notifications.show({ color: "red", message: "Network error requesting payment plan.", autoClose: false });
    } finally {
      setEnrolling(false);
    }
  };

  const handleEnroll = async () => {
    if (!session) {
      router.push('/');
      return;
    }
    if (selectedParticipantIds.length === 0) return;

    const isPayingOnShopify = program?.orgMemberPriceCents || program?.nonOrgMemberPriceCents;

    setEnrolling(true);
    setMessage("");

    let navigating = false; // only the Shopify redirect keeps the spinner past finally
    try {
      // Resolve the Shopify checkout details BEFORE enrolling. A paid program with
      // no variant (or no store domain) can never be charged, so it must fail here
      // instead of creating a free, unchargeable enrollment.
      let variantId: string | null = null;
      let storeDomain: string | undefined;
      // ENV GATE (mirrors server config.shopifyMockActive ⇔ CHECKIN_ENV=local):
      //   local     → mockPay: settle the charge in-app via the Debug orders/paid
      //               webhook, no redirect (there is no local Shopify store).
      //   dev/prod  → redirect to the real store (storeDomain required).
      // Variant is always required — local synthesizes dev-mock-variant ids, so a null
      // one is a real config gap in every env.
      let mockPay = false;
      let isMember = false;
      // Pricing goes by the server-computed duration-aware flag when present (a
      // member not covered through this program's end must pay full price);
      // ?? isMember is the fallback for an older cached response missing it.
      let pricingEligible = false;
      if (isPayingOnShopify && program) {
        const householdRes = await fetch('/api/household');
        if (householdRes.ok) {
          const householdData = await householdRes.json();
          isMember = householdData.household?.orgMembership?.status === "ACTIVE" || false;
        }
        pricingEligible = program.viewerMemberPricingEligible ?? isMember;
        // Every program sells the SAME variant to everyone — the discount code
        // (below, at redirect time) does the member pricing, not a variant pick.
        variantId = program.shopifyVariantId;
        storeDomain = shopifyStoreDomain ?? undefined;
        mockPay = isLocalInstance;
        if (!variantId || (!mockPay && !storeDomain)) {
          notifications.show({ color: "red", autoClose: false, message: variantId
            ? "Cannot enroll: Shopify store domain not configured. Contact an admin."
            : "Cannot enroll: no pricing variant set for this program — set one in program-ops." });
          return; // no enrollment created — payment path is broken
        }
      }

      const outcomes: EnrollOutcome[] = [];
      for (const participantId of selectedParticipantIds) {
        const res = await fetch(`/api/programs/${id}/participants`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ participantId })
        });

        // Only the error path carries a JSON body we need (error/requiresOverride);
        // ok and 409 (already enrolled) are both treated as enrolled downstream.
        const data = (res.ok || res.status === 409) ? {} : await res.json();
        outcomes.push({ participantId, ok: res.ok, status: res.status, error: data.error, requiresOverride: data.requiresOverride });
      }

      const { enrolledIds, errors } = aggregateEnrollOutcomes(outcomes);

      if (enrolledIds.length > 0) {
        notifyNavRefresh();
        if (isPayingOnShopify && program && variantId && mockPay) {
          // Local mock: fire the Debug section's orders/paid webhook to activate the
          // PENDING enrollments, exactly as the dev Shopify tool's button does — no redirect.
          const payRes = await fetch('/api/dev/shopify/orders-paid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ programId: program.id, participantIds: enrolledIds }),
          });
          if (payRes.ok) {
            notifications.show({ message: "Payment mocked (local) — enrollment activated." });
          } else {
            notifications.show({ color: "red", autoClose: false, message: "Enrolled, but the mock payment failed — fire it from the Debug → Shopify tool." });
          }
          fetchProgram();
        } else if (isPayingOnShopify && program && variantId && storeDomain) {
          setSuccessMessage("Redirecting to Shopify for secure payment...");
          navigating = true;
          // Single-pool model only: a member checking out gets a per-enrollee,
          // single-use discount code minted server-side (the browser never has
          // Shopify credentials to do this itself). Legacy two-variant programs
          // already charged the right tier via the variant pick above — no code
          // needed. Failure here is non-fatal: an undiscounted link is always a
          // safe fallback (never blocks checkout), per lib/shopify.ts's
          // mintMemberDiscountCode contract.
          let discountCode: string | null = null;
          if (program.shopifyVariantId && pricingEligible) {
            try {
              const discRes = await fetch(`/api/programs/${id}/discount-code`, { method: 'POST' });
              if (discRes.ok) discountCode = (await discRes.json()).code ?? null;
            } catch { /* undiscounted link is an acceptable fallback */ }
          }
          // qty=N single variant + comma-joined account ids — see buildShopifyCheckoutUrl.
          window.location.href = buildShopifyCheckoutUrl(storeDomain, variantId, enrolledIds, id, discountCode);
          return; // spinner stays; page unloads on redirect
        } else {
          notifications.show({ message: enrolledIds.length > 1 ? `Successfully enrolled ${enrolledIds.length} members!` : "Successfully enrolled!" });
          fetchProgram();
        }
      }

      if (errors.length > 0) setMessage(errors.join(" "));
    } catch {
      notifications.show({ color: "red", message: "Network error during enrollment.", autoClose: false });
    } finally {
      if (!navigating) setEnrolling(false);
    }
  };

  if (loading || status === "loading") {
    return <PageLoader />;
  }

  if (!program) return (
    <Container size="sm" py="xl">
      <Card withBorder radius="md" padding="xl" ta="center">
        <Title order={3}>{message || "Not Found"}</Title>
        <Group justify="center" mt="lg">
          <Button onClick={() => router.push('/programs')}>Back to Directory</Button>
        </Group>
      </Card>
    </Container>
  );

  const user = session?.user;
  const canManage = !!(session && (user?.isSysadmin || user?.isBoardMember || user?.id === program.leadMentorId));

  // My household's already-enrolled members — shown so a returning parent doesn't
  // re-attempt an enrollment that would 409. name/householdId are public tier, so
  // they survive the stripper; no extra household fetch needed here.
  const myEnrolled = (program.participants ?? [])
    .filter(p => p.person && (p.personId === user?.id || (user?.householdId != null && p.person.householdId === user.householdId)))
    .map(p => ({
      name: p.personId === user?.id ? (p.person?.name || 'You') : (p.person?.name || 'Household member'),
      active: p.status === 'ACTIVE',
    }));
  const isClosed = program.enrollmentStatus === 'CLOSED';
  const hasPrice = !!(program.orgMemberPriceCents || program.nonOrgMemberPriceCents);
  // A youth is shown no payment obligation, action, or status — their own or
  // their household's (docs/rules/programs.md). An unverifiable age is NOT a
  // youth: they keep every affordance so they can reach the intake panel and
  // establish an age.
  const viewerIsYouth = user?.ageBand === 'youth';

  const ageRange = program.minAge !== null && program.maxAge !== null ? `ages ${program.minAge}–${program.maxAge}`
    : program.minAge !== null ? `ages ${program.minAge} and up`
    : program.maxAge !== null ? `ages ${program.maxAge} and under` : null;

  // Why is enrollment closed? Full wins over phase.
  const enrolledCount = program._count?.participants ?? program.participants?.length ?? 0;
  const isFull = program.maxParticipants != null && enrolledCount >= program.maxParticipants;
  const closedReason = !isClosed ? null
    : isFull ? 'Full'
    : program.phase === 'RUNNING' ? 'Running'
    : program.phase === 'UPCOMING' ? 'Upcoming'
    : program.phase === 'FINISHED' ? 'Ended'
    : null;
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
                  <Text key={i} size="sm" c={m.active ? 'green' : 'yellow'} ml="sm">
                    {m.name} — {m.active ? 'Enrolled' : 'Enrolled, payment pending'}
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

        {/* A current member whose membership doesn't cover this program's whole
            run doesn't get member pricing on it — the discount-code fetch's
            `reason` reinforces this at checkout time, so it isn't repeated here. */}
        {program.viewerIsMember === true && program.viewerMemberPricingEligible === false && (
          <Alert color="yellow" variant="light" mb="lg">
            Your membership ends before this program finishes, so member pricing doesn&apos;t apply — renew your membership first to enroll at the member price.
          </Alert>
        )}

        {message && <Alert color="red" mb="lg">{message}</Alert>}
        {successMessage && <Alert mb="lg">{successMessage}</Alert>}

        <Center mt="xl">
          {!showEnrollmentSelection ? (
            <Group justify="center" wrap="wrap">
              {session ? (
                <Button size="md" onClick={startEnrollmentProcess} disabled={isClosed || viewerIsYouth}>
                  {/* A payment-pending household reads "Continue enrollment" — the
                      button resumes their checkout (see the pending picker state),
                      it doesn't start a new one. A youth is told who may act
                      instead, which holds whether or not the program is priced. */}
                  {isClosed ? <>Enrollment Closed{closedSuffix}</>
                    : viewerIsYouth ? "A household lead must enroll you"
                    : myEnrolled.some((m) => !m.active) ? "Continue enrollment" : "Enroll"}
                </Button>
              ) : (
                // Auth-first: route through /signin (which picks Google vs. the
                // offline dev picker by env) BEFORE any intake, so account
                // existence is resolved by NextAuth, never leaked by a public API
                // response. First-time users are then filled in by the intake
                // panel below.
                <Button size="md" onClick={() => router.push(`/signin?callbackUrl=/programs/${program.id}`)} disabled={isClosed}>
                  {isClosed ? <>Enrollment Closed{closedSuffix}</> : "Sign in to enroll"}
                </Button>
              )}
            </Group>
          ) : (
            <Card withBorder radius="md" padding="lg" w="100%" maw={showIntake ? 640 : 500}>
              {showIntake ? (
                <FirstTimeIntakePanel
                  ageGated={program.minAge !== null || program.maxAge !== null}
                  onSaved={handleIntakeSaved}
                />
              ) : (
              <>
              <Title order={4} mb="lg">Which of your household wants to enroll?</Title>

              {loadingHousehold ? (
                <Center py="md"><Loader size="sm" /></Center>
              ) : (
                <Checkbox.Group
                  value={selectedParticipantIds.map(String)}
                  onChange={(vals) => setSelectedParticipantIds(vals.map(Number))}
                  mb="lg"
                >
                  <Stack>
                    {householdMembers.map((member) => {
                      const { reason, label } = enrollBlock(member);
                      const disabled = reason !== null && reason !== 'pending';

                      return (
                        <Card key={member.id} withBorder radius="md" padding="sm" opacity={disabled ? 0.5 : 1}>
                          <Group justify="space-between">
                            <Checkbox
                              value={String(member.id)}
                              disabled={disabled}
                              label={member.name || 'Unnamed Participant'}
                            />
                            {reason === 'enrolled' && <Text size="sm" c="green">({label})</Text>}
                            {(reason === 'pending' || reason === 'awaiting') && <Text size="sm" c="yellow">({label})</Text>}
                            {disabled && reason !== 'enrolled' && reason !== 'awaiting' && <Text size="sm" c="red">({label})</Text>}
                          </Group>
                        </Card>
                      );
                    })}
                  </Stack>
                </Checkbox.Group>
              )}

              {!loadingHousehold && needsSetup ? (
                // Replaces the old dead-end "no eligible participants" alert: a
                // first-time user finishes their household here, then enrolls.
                <Stack align="center" gap="sm">
                  <Text c="dimmed" size="sm" ta="center">
                    Finish setting up your household to enroll{ageRange ? ` (${ageRange})` : ''}.
                  </Text>
                  <Button fullWidth size="md" onClick={() => setShowIntake(true)}>
                    Finish setting up your household to enroll
                  </Button>
                </Stack>
              ) : (
              <Stack align="center">
                {selectedParticipantIds.length === 0 && (
                  <Text size="sm" c="dimmed" ta="center">
                    Check the box next to each person you want to enroll.
                  </Text>
                )}

                <Button
                  fullWidth
                  size="md"
                  onClick={() => handleEnroll()}
                  disabled={enrolling || selectedParticipantIds.length === 0 || loadingHousehold}
                  loading={enrolling}
                >
                  {hasPrice ? "Pay on Shopify" : "Complete Enrollment"}
                </Button>

                {hasPrice && !isClosed && !viewerIsYouth && (
                  <Button
                    fullWidth
                    size="md"
                    variant="light"
                    type="button"
                    onClick={handleRequestPaymentPlan}
                    disabled={enrolling || selectedParticipantIds.length === 0 || loadingHousehold}
                    styles={{ root: { height: 'auto', paddingBlock: 'var(--mantine-spacing-xs)' }, label: { whiteSpace: 'normal' } }}
                  >
                    Request a scholarship or payment plan from the Scholarship Review Team
                  </Button>
                )}
              </Stack>
              )}

              {/* No force-enroll here: this picker only ever offers the caller's
                  own household, so every enrollment from this page is conflicted
                  and the server refuses the limit override. The refusal reason
                  shows in the red message Alert above. Comping someone else is
                  program-ops (ProgramRosterTab). */}
              </>
              )}
            </Card>
          )}
        </Center>
      </Card>
    </Container>
  );
}
