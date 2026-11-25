import { useRef, useState } from 'react';
import { useOrgTime } from "@/components/TimezoneProvider";
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useDisclosure } from '@mantine/hooks';
import { errorMessage, HttpError, invalidateLoads, showError, showSuccess } from '@checkin/component-ui';
import { api, useLoad } from '@/lib/api';
import { checkProgramAge } from '@/lib/programAge';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { aggregateEnrollOutcomes, buildShopifyCheckoutUrl, findRepeatPayments, type EnrollOutcome, type RepeatPayment } from './enroll';
import { checkoutVariantId } from '@/lib/programs/variants';
import type { EnrollmentClosedBy } from '@/lib/programs/saleState';
import { useIsLocalInstance, useShopifyStoreDomain } from '@/components/EnvProvider';

export type ProgramDetail = {
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
  // Server-derived: why a new claim would be refused, null when open.
  enrollmentClosedBy: EnrollmentClosedBy | null;
  orgMemberPriceCents: number | null;
  nonOrgMemberPriceCents: number | null;
  // Single-pool model: the ONE variant for both tiers — member pricing comes
  // from a checkout-time discount code (see handleEnroll), not a separate variant.
  shopifyVariantId: string | null;
  claimantShopifyVariantId?: string | null;
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

type HouseholdMember = { id: number; name: string | null; dateOfBirth: string | null; isDeclaredAdult?: boolean };
type HouseholdAnswer = { household: { householdMembers?: HouseholdMember[] } | null };
type CheckoutPlan = { enrolledIds: number[]; variantId: string; storeDomain: string | undefined; mockPay: boolean; pricingEligible: boolean };
/** Who was refused and why, and the checkout for the rest (null when nobody was accepted). */
export type RefusedPause = { refusals: { name: string; reason: string }[]; accepted: string[]; plan: CheckoutPlan | null };
type IntakeAnswer = { hasEmergencyContact?: boolean };

/** A write's refusal as an outcome, so one member's refusal doesn't stop the rest. Anything else still throws. */
async function attempt(write: Promise<unknown>): Promise<{ status: number; error?: string }> {
  try {
    await write;
    return { status: 200 };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, error: e.message };
    throw e;
  }
}

/** Program load, household picker state and the enroll / payment-plan actions for the program page. */
export function useProgramEnrollment(id: string) {
  const { today } = useOrgTime();
  const { data: session, status, update: updateSession } = useSession();
  const router = useRouter();
  // /signin validates callbackUrl and returns the visitor here once signed in.
  const signInToProgram = () => router.push(`/signin?callbackUrl=${encodeURIComponent(`/programs/${id}`)}`);
  const isLocalInstance = useIsLocalInstance();
  const shopifyStoreDomain = useShopifyStoreDomain();

  const programLoad = useLoad<ProgramDetail>(`/api/programs/${id}`);
  const program = programLoad.data;
  const [enrolling, setEnrolling] = useState(false);
  // A second click lands before React re-renders the disabled button, so the in-flight check is a ref.
  const writing = useRef(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [planKind, setPlanKind] = useState<string | null>(null);
  const [confirmPlanOpened, { open: openConfirmPlan, close: closeConfirmPlan }] = useDisclosure(false);
  const [repeatPayments, setRepeatPayments] = useState<RepeatPayment[]>([]);
  const [refusedPause, setRefusedPause] = useState<RefusedPause | null>(null);

  const [showEnrollmentSelection, setShowEnrollmentSelection] = useState(false);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<number[]>([]);
  const [showIntake, setShowIntake] = useState(false);
  // An unknown age sees no payment surface; the intake panel asks for a DOB (or "over 25") first.
  const ageUnknown = !!session && session.user.ageBand !== 'adult' && session.user.ageBand !== 'youth';

  const householdLoad = useLoad<HouseholdAnswer>(showEnrollmentSelection ? '/api/household' : null);
  // Emergency contact isn't in /api/household; the process-free intake state has it.
  const intakeLoad = useLoad<IntakeAnswer>(showEnrollmentSelection ? '/api/household/intake' : null);

  // Why a member can't be enrolled. Shared by the setup check and the row render
  // so an ineligible member is never selected and then POSTed.
  const enrollBlock = (member: HouseholdMember): { reason: 'enrolled' | 'pending' | 'age' | 'dob' | 'lead' | null; label: string } => {
    // Only a known adult may commit THEMSELVES to a program and its charge — the
    // enroll route refuses the rest, so the viewer's own row must never offer it.
    const viewer = session?.user;
    const selfBlocked = member.id === viewer?.id && viewer?.ageBand !== 'adult';
    const enrolledRow = (program?.participants ?? []).find(p => p.personId === member.id);
    // PENDING = payment still owed: SELECTABLE, so the household can re-run
    // checkout to finish paying (the participants POST 409s and
    // aggregateEnrollOutcomes folds a 409 back into the checkout set — the same
    // idempotent path as a double-click). Anything else is locked: ACTIVE, or no
    // status at all because this viewer may not see payment status.
    if (enrolledRow) {
        if (enrolledRow.status !== 'PENDING') return { reason: 'enrolled', label: 'Enrolled' };
        if (selfBlocked) return { reason: 'dob', label: 'DOB missing' };
        return { reason: 'pending', label: 'Not paid yet — select to pay now' };
    }
    if (!program) return { reason: null, label: '' };
    // Same eligibility rule as the enroll route: a declared over-25 adult clears
    // a youth minimum like "16 and up" without a DOB on file.
    const check = checkProgramAge(member, { minAge: program.minAge, maxAge: program.maxAge, asOf: program.startAt ?? today() });
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

  const household = householdLoad.data?.household;
  const householdMembers: HouseholdMember[] = !householdLoad.data ? []
    : household?.householdMembers ?? (session ? [{ id: session.user.id, name: "Myself", dateOfBirth: null }] : []);
  const memberName = (personId: number) => householdMembers.find((m) => m.id === personId)?.name || 'One member';
  // After an intake save the picker waits for the re-read, so it never shows the household as it was.
  const [refreshingHousehold, setRefreshingHousehold] = useState(false);
  const loadingHousehold = refreshingHousehold || (!householdLoad.data && !householdLoad.error) || (!intakeLoad.data && !intakeLoad.error);
  // The enroll routes don't check the emergency contact, so a probe that can't answer blocks enrolment.
  const householdError = householdLoad.error ?? intakeLoad.error;
  const householdErrorWhat = householdLoad.error ? "your household" : "your emergency contact";
  const reloadHousehold = () => Promise.all([householdLoad.reload(), intakeLoad.reload()]);
  const hasValidEmergencyContact = intakeLoad.data?.hasEmergencyContact === true;
  const hasEnrollable = householdMembers.some((m) => { const r = enrollBlock(m).reason; return r === null || r === 'pending'; });
  // A freshly-signed-in user with no enrollable participant or no emergency contact is offered setup instead of a dead end.
  const needsSetup = ageUnknown || (!!householdLoad.data && (!hasEnrollable || !hasValidEmergencyContact));

  const startEnrollmentProcess = () => {
    if (!session) {
      signInToProgram();
      return;
    }
    // Nobody is pre-checked: enrolling creates a PENDING row and a payment
    // obligation, so each participant must be an explicit click — including
    // the account holder, the easiest person to enroll by accident.
    setSelectedParticipantIds([]);
    setShowEnrollmentSelection(true);
    if (ageUnknown) setShowIntake(true);
  };

  // Back from the first-time intake panel: re-read the household so the new
  // member and emergency contact show in the normal member-select.
  const handleIntakeSaved = async () => {
    setShowIntake(false);
    setSelectedParticipantIds([]);
    setRefreshingHousehold(true);
    try {
      // Intake just set a DOB or the over-25 flag. Re-stamp the session so the
      // ageBand claim reflects it NOW — the jwt callback refreshes on its own
      // schedule, and this is the one flow where waiting would leave a member who
      // just proved their age still blocked from enrolling.
      await Promise.all([updateSession(), reloadHousehold()]);
    } finally {
      setRefreshingHousehold(false);
    }
  };

  const handleRequestPaymentPlan = async () => {
    if (!session) return signInToProgram();
    if (selectedParticipantIds.length === 0) return;
    if (!planKind) return;
    if (writing.current) return;
    writing.current = true;
    closeConfirmPlan();
    setEnrolling(true);

    const errors: string[] = [];
    let anyRequested = false;

    try {
      for (const participantId of selectedParticipantIds) {
        const enrollRes = await attempt(api(`/api/programs/${id}/participants`, {
          method: 'POST',
          body: JSON.stringify({ participantId }),
          invalidate: false,
        }));

        // A 409 means the row already exists; the plan route decides whether it can take a request.
        if (enrollRes.status !== 200 && enrollRes.status !== 409) {
          errors.push(enrollRes.error ?? "Failed to start enrollment.");
          continue;
        }

        const res = await attempt(api(`/api/programs/${id}/request-payment-plan`, {
          method: 'POST',
          // One choice covers the whole selected batch: the ask is the household's
          // situation, not the individual participant's.
          body: JSON.stringify({ participantId, kind: planKind }),
          invalidate: false,
        }));

        if (res.status === 200) {
          anyRequested = true;
        } else if (enrollRes.status === 200 && res.status >= 500) {
          errors.push("Enrolled as pending, but failed to alert the Scholarship Review Team for one member. Please email them directly.");
        } else {
          const name = householdMembers.find((m) => m.id === participantId)?.name ?? "One member";
          errors.push(res.status < 500
            ? `${name}: ${res.error ?? "This request can't go ahead."}`
            : `${name}: We couldn't send your request to the Scholarship Review Team. Please email them directly.`);
        }
      }

      if (anyRequested) {
        showSuccess("Requested! Please check your email for communication from the Scholarship Review Team.");
        notifyNavRefresh();
      }
      errors.forEach((e) => showError(e));
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      invalidateLoads();
      writing.current = false;
      setEnrolling(false);
    }
  };

  /** Checks out exactly these children: mock payment on a local instance, else the Shopify redirect. True when leaving the page. */
  const goToCheckout = async ({ enrolledIds, variantId, storeDomain, mockPay, pricingEligible }: CheckoutPlan): Promise<boolean> => {
    // Every checkout starts at the server: it refuses a checkout naming
    // someone outside the household (400) or from a non-lead (403), and mints the member discount code for
    // single-pool programs when the household's membership fee covers the program. A
    // mint failure is non-fatal: an undiscounted link is always a safe fallback,
    // per lib/shopify/discounts.ts's mintMemberDiscountCode contract. The checkout
    // signature is not optional: without it the order activates nobody.
    let discountCode: string | null = null;
    let signature: string | null = null;
    try {
      const data = await api<{ code?: string | null; signature?: string | null }>(`/api/programs/${id}/discount-code`, {
        method: 'POST',
        body: JSON.stringify({ participantIds: enrolledIds }),
        invalidate: false,
      });
      discountCode = pricingEligible ? data.code ?? null : null;
      signature = data.signature ?? null;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 400 || e.status === 403)) {
        showError(e.message);
        return false;
      }
      // Any other failure leaves no signature: refused below.
    }
    if (mockPay) {
      // Local mock: fire the Debug section's orders/paid webhook to activate the
      // PENDING enrollments, exactly as the dev Shopify tool's button does — no redirect.
      try {
        await api('/api/dev/shopify/orders-paid', {
          method: 'POST',
          body: JSON.stringify({ programId: Number(id), participantIds: enrolledIds }),
          invalidate: false,
        });
        showSuccess("Payment mocked (local) — enrollment activated.");
      } catch {
        showError("Enrolled, but the mock payment failed — fire it from the Debug → Shopify tool.");
      }
      return false;
    }
    if (!signature) {
      showError("We couldn't start the checkout. Please try again.");
      return false;
    }
    setSuccessMessage("Redirecting to Shopify for secure payment...");
    // qty=N single variant + comma-joined account ids — see buildShopifyCheckoutUrl.
    window.location.href = buildShopifyCheckoutUrl(storeDomain, variantId, enrolledIds, id, signature, discountCode);
    return true; // spinner stays; page unloads on redirect
  };

  const handleEnroll = async (confirmedRepeat = false) => {
    if (!session) {
      signInToProgram();
      return;
    }
    if (selectedParticipantIds.length === 0) return;
    if (writing.current) return;
    writing.current = true;

    const isPayingOnShopify = program?.orgMemberPriceCents || program?.nonOrgMemberPriceCents;

    setEnrolling(true);

    let navigating = false; // only the Shopify redirect keeps the spinner past finally
    let wrote = false;
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
      // Pricing goes by the server-computed duration-aware flag: a member not covered
      // through this program's end pays full price, and an absent flag gets no discount.
      let pricingEligible = false;
      if (isPayingOnShopify && program) {
        pricingEligible = program.viewerMemberPricingEligible === true;
        // Every app checkout follows a claim, so it sells the claimant variant when
        // the program has one; the discount code (below) does the member pricing.
        variantId = checkoutVariantId(program);
        storeDomain = shopifyStoreDomain ?? undefined;
        mockPay = isLocalInstance;
        if (!variantId || (!mockPay && !storeDomain)) {
          showError(variantId
            ? "Cannot enroll: Shopify store domain not configured. Contact an admin."
            : "Cannot enroll: no pricing variant set for this program — set one in program-ops.");
          return; // no enrollment created — payment path is broken
        }
      }

      // Re-read the roster first: a child may have been paid since this page
      // loaded, and the participants POST answers that with a 409 like any re-run.
      if (isPayingOnShopify && !confirmedRepeat) {
        // The warning is advisory: a failed re-read checks the page's roster instead.
        const fresh = await api<ProgramDetail>(`/api/programs/${id}`).catch((err: unknown) => {
          console.warn("[programs] roster re-read failed; checking repeat payments against the loaded roster", err);
          return null;
        });
        const repeats = findRepeatPayments(
          selectedParticipantIds,
          (fresh ?? program)?.participants ?? [],
          (personId) => householdMembers.find((m) => m.id === personId)?.name,
        );
        if (repeats.length > 0) {
          setRepeatPayments(repeats);
          return; // the warning modal re-enters with confirmedRepeat
        }
      }

      const outcomes: EnrollOutcome[] = [];
      wrote = true;
      for (const participantId of selectedParticipantIds) {
        const res = await attempt(api(`/api/programs/${id}/participants`, {
          method: 'POST',
          body: JSON.stringify({ participantId }),
          invalidate: false,
        }));
        // ok and 409 (already enrolled) are both treated as enrolled downstream.
        outcomes.push({ participantId, ok: res.status === 200, status: res.status, error: res.error });
      }

      const { enrolledIds, refused } = aggregateEnrollOutcomes(outcomes);
      const named = refused.map((r) => ({ name: memberName(r.participantId), reason: r.error }));

      if (enrolledIds.length > 0) notifyNavRefresh();

      if (isPayingOnShopify && variantId) {
        const plan: CheckoutPlan = { enrolledIds, variantId, storeDomain, mockPay, pricingEligible };
        // A refusal pauses before checkout so the family sees who was left out; the accepted claims stay held.
        if (refused.length > 0) {
          setRefusedPause({ refusals: named, accepted: enrolledIds.map(memberName), plan: enrolledIds.length > 0 ? plan : null });
          return;
        }
        navigating = await goToCheckout(plan);
        return;
      }

      if (enrolledIds.length > 0) {
        showSuccess(enrolledIds.length > 1 ? `Successfully enrolled ${enrolledIds.length} members!` : "Successfully enrolled!");
      }
      named.forEach((r) => showError(`${r.name}: ${r.reason}`));
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      if (!navigating) {
        if (wrote) invalidateLoads();
        writing.current = false;
        setEnrolling(false);
      }
    }
  };

  const continueToCheckout = async () => {
    const plan = refusedPause?.plan;
    setRefusedPause(null);
    if (!plan || writing.current) return;
    writing.current = true;
    setEnrolling(true);
    let navigating = false;
    try {
      navigating = await goToCheckout(plan);
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      if (!navigating) {
        invalidateLoads();
        writing.current = false;
        setEnrolling(false);
      }
    }
  };

  return {
    session, status, program, programLoad, successMessage, startEnrollmentProcess, signInToProgram, showEnrollmentSelection, ageUnknown,
    picker: {
      showIntake, setShowIntake, handleIntakeSaved, loadingHousehold, householdError, householdErrorWhat, reloadHousehold, householdMembers, enrollBlock, needsSetup,
      selectedParticipantIds, setSelectedParticipantIds, enrolling, handleEnroll, repeatPayments, setRepeatPayments,
      refusedPause, setRefusedPause, continueToCheckout,
      planKind, setPlanKind, confirmPlanOpened, openConfirmPlan, closeConfirmPlan, handleRequestPaymentPlan,
    },
  };
}

export type EnrollmentPickerControls = ReturnType<typeof useProgramEnrollment>["picker"];
