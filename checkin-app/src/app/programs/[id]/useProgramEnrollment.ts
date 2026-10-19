import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { notifications } from '@mantine/notifications';
import { useDisclosure } from '@mantine/hooks';
import { checkProgramAge } from '@/lib/programAge';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { aggregateEnrollOutcomes, buildShopifyCheckoutUrl, findRepeatPayments, type EnrollOutcome, type RepeatPayment } from './enroll';
import { checkoutVariantId } from '@/lib/programs/variants';
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

/** Program load, household picker state and the enroll / payment-plan actions for the program page. */
export function useProgramEnrollment(id: string) {
  const { data: session, status, update: updateSession } = useSession();
  const router = useRouter();
  const isLocalInstance = useIsLocalInstance();
  const shopifyStoreDomain = useShopifyStoreDomain();

  const [program, setProgram] = useState<ProgramDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [message, setMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [planKind, setPlanKind] = useState<string | null>(null);
  const [confirmPlanOpened, { open: openConfirmPlan, close: closeConfirmPlan }] = useDisclosure(false);
  const [repeatPayments, setRepeatPayments] = useState<RepeatPayment[]>([]);

  const [showEnrollmentSelection, setShowEnrollmentSelection] = useState(false);
  const [householdMembers, setHouseholdMembers] = useState<{ id: number; name: string | null; dateOfBirth: string | null; isDeclaredAdult?: boolean }[]>([]);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<number[]>([]);
  const [loadingHousehold, setLoadingHousehold] = useState(false);
  // First-time gap: a freshly-signed-in user has a single-person household with
  // no enrollable participant and/or no emergency contact. When set, we offer the
  // intake panel instead of the dead-end "no eligible participants" alert.
  const [needsSetup, setNeedsSetup] = useState(false);
  const [showIntake, setShowIntake] = useState(false);

  const fetchProgram = useCallback(() => fetch(`/api/programs/${id}`)
    .then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setProgram(data);
      } else if (res.status === 404) {
        setMessage("Program not found.");
      } else {
        setMessage("Failed to load program details.");
      }
    })
    .catch(() => {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    })
    .finally(() => {
      setLoading(false);
    }),
  [id]);

  useEffect(() => {
    fetchProgram();
  }, [fetchProgram]);

  // Why a member can't be enrolled. Shared by the default selection and the row
  // render so an ineligible member is never auto-selected and then POSTed (which
  // returned a confusing "Date of Birth is missing" for over-25 adults).
  const enrollBlock = (member: { id: number; dateOfBirth: string | null; isDeclaredAdult?: boolean }): { reason: 'enrolled' | 'pending' | 'age' | 'dob' | 'lead' | null; label: string } => {
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
    if (!planKind) return;
    closeConfirmPlan();

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
          // One choice covers the whole selected batch: the ask is the household's
          // situation, not the individual participant's.
          body: JSON.stringify({ participantId, kind: planKind })
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

  const handleEnroll = async (confirmedRepeat = false) => {
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
        // Every app checkout follows a claim, so it sells the claimant variant when
        // the program has one; the discount code (below) does the member pricing.
        variantId = checkoutVariantId(program);
        storeDomain = shopifyStoreDomain ?? undefined;
        mockPay = isLocalInstance;
        if (!variantId || (!mockPay && !storeDomain)) {
          notifications.show({ color: "red", autoClose: false, message: variantId
            ? "Cannot enroll: Shopify store domain not configured. Contact an admin."
            : "Cannot enroll: no pricing variant set for this program — set one in program-ops." });
          return; // no enrollment created — payment path is broken
        }
      }

      // Re-read the roster first: a child may have been paid since this page
      // loaded, and the participants POST answers that with a 409 like any re-run.
      if (isPayingOnShopify && !confirmedRepeat) {
        // The warning is advisory: a failed re-read checks the page's roster instead.
        const fresh: ProgramDetail | null = await fetch(`/api/programs/${id}`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .catch((err: unknown) => {
            console.warn("[programs] roster re-read failed; checking repeat payments against the loaded roster", err);
            return null;
          });
        if (fresh) setProgram(fresh);
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
        // Every checkout starts at the server: it refuses a checkout naming
        // someone outside the household (400) or from a non-lead (403), and mints the member discount code for
        // single-pool programs when the household's membership fee covers the program. A
        // mint or network failure is non-fatal: an undiscounted link is always a
        // safe fallback, per lib/shopify/discounts.ts's mintMemberDiscountCode contract.
        let discountCode: string | null = null;
        if (isPayingOnShopify) {
          let refusal: string | null = null;
          try {
            const discRes = await fetch(`/api/programs/${id}/discount-code`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ participantIds: enrolledIds }),
            });
            if (discRes.ok) discountCode = pricingEligible ? (await discRes.json()).code ?? null : null;
            else if (discRes.status === 400 || discRes.status === 403) refusal = (await discRes.json()).error ?? "This checkout can't go ahead.";
          } catch { /* undiscounted link is an acceptable fallback */ }
          if (refusal) {
            setMessage(refusal);
            fetchProgram();
            return;
          }
        }
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

  return {
    session, status, program, loading, message, successMessage, startEnrollmentProcess, showEnrollmentSelection,
    picker: {
      showIntake, setShowIntake, handleIntakeSaved, loadingHousehold, householdMembers, enrollBlock, needsSetup,
      selectedParticipantIds, setSelectedParticipantIds, enrolling, handleEnroll, repeatPayments, setRepeatPayments,
      planKind, setPlanKind, confirmPlanOpened, openConfirmPlan, closeConfirmPlan, handleRequestPaymentPlan,
    },
  };
}

export type EnrollmentPickerControls = ReturnType<typeof useProgramEnrollment>["picker"];
