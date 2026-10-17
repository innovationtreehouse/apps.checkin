import { useState, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import type { OrgMembershipProcessStatus, OrgMembershipStatus } from "@/generated/prisma/client";
import { notifications } from "@mantine/notifications";
import { useDisclosure } from "@mantine/hooks";
import type { AlertTone } from "@/components/admin/AlertBanner";
import { notifyNavRefresh } from "@/lib/nav-refresh";
import { useUnsavedGuard } from "@/components/UnsavedChangesProvider";
import {
  buildIntakePayload, mapServerFields, useMembershipForm, validateIntake, type IntakePrefill,
} from "./membershipForm";

// Payment holdoff (below): sessionStorage key for the awaiting-payment record
// set by a real Shopify checkout click.
const awaitingPaymentKey = (processId: number) => `membership_awaiting_payment_${processId}`;

export interface ExternalStatus {
  contractSigned: boolean;
  contractStarted: boolean;
  signerName?: string | null;
  contractSignedAt?: string | null;
  bgConsented: boolean;
  bgCleared: boolean;
  deepLinkUrl: string | null;
}

export interface MembershipProcess {
  id: number;
  kind: string;
  status: OrgMembershipProcessStatus;
  isPaymentPlanRequested?: boolean;
}

export interface IntakeState {
  hasHousehold: boolean;
  isLead: boolean;
  membershipStatus: OrgMembershipStatus | null;
  process: MembershipProcess | null;
  external: ExternalStatus | null;
  /** The caller's own unsigned individual agreement, independent of the household's. */
  personAgreement: { id: number; started: boolean } | null;
  prefill: IntakePrefill;
}

export interface MembershipPayment {
  amountCents: number;
  checkoutUrl: string | null;
}

// Build an error message from an API response, appending the dev-only `detail`
// (the real server failure) when present so an "Internal Server Error" isn't a
// dead end. Falls back to a friendly default when the body carries nothing.
export const apiError = (data: { error?: string; detail?: string } | null | undefined, fallback: string) =>
  [data?.error, data?.detail].filter(Boolean).join(" — ") || fallback;

const networkError = () => notifications.show({ color: "red", message: "Network error.", autoClose: false });

/** State, data loading and actions for the membership page. */
export function useMembershipPage() {
  const { data: session, status: sessionStatus } = useSession();

  const [state, setState] = useState<IntakeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: AlertTone } | undefined>();
  // Per-field validation errors, keyed by form field ("address", "emName",
  // "emPhone", "primaryName"). Drives the red-highlighted inputs.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Non-fatal notes from a save: parts that didn't go through (e.g. a second
  // guardian over the household cap) while the rest of the form did save.
  const [warnings, setWarnings] = useState<string[]>([]);
  const form = useMembershipForm();
  const [payment, setPayment] = useState<MembershipPayment | null>(null);
  // Set when the applicant clicks the real Shopify checkout link (not the local
  // mock, which settles synchronously and never needs a holdoff). Persisted to
  // sessionStorage keyed by process id, so a tab refresh mid-checkout keeps the
  // message. Cleared implicitly whenever a server-side path — the orders/paid
  // webhook today, an s-read reconciliation possibly in the future — moves the
  // process out of PENDING_PAYMENT, or explicitly via the escape-hatch link.
  const [awaitingPayment, setAwaitingPayment] = useState<{ processId: number } | null>(null);
  // Flips true once the household asks the Scholarship Review Team for a payment plan.
  // Seeded from the server flag so a reload (or another device) still shows the
  // request as received rather than resurrecting the button.
  const [planRequested, setPlanRequested] = useState(false);
  const [planKind, setPlanKind] = useState<string | null>(null);
  const [confirmPlanOpened, { open: openConfirmPlan, close: closeConfirmPlan }] = useDisclosure(false);
  // Self-report gate for the background-check task (#875): the confirm checkbox
  // unlocks only after the applicant has opened the Averity consent link this
  // visit, so they can't confirm a form they never saw.
  const [bgLinkOpened, setBgLinkOpened] = useState(false);
  const [bgConsenting, setBgConsenting] = useState(false);

  // Drop the holdoff and its sessionStorage record — the "Show the payment
  // button again" escape hatch for an abandoned checkout.
  const clearAwaitingPayment = useCallback(() => {
    setAwaitingPayment((cur) => {
      if (cur) sessionStorage.removeItem(awaitingPaymentKey(cur.processId));
      return null;
    });
  }, []);

  const { reset: resetForm } = form;
  const hydrate = useCallback((s: IntakeState) => {
    setState(s);
    // Restore an in-flight payment holdoff after a tab refresh mid-Shopify-checkout.
    // Once the process has moved out of PENDING_PAYMENT — the orders/paid webhook
    // settled it, or (possibly, in the future) an s-read reconciliation did — drop
    // the holdoff and its sessionStorage record. Deliberately no background
    // polling: the dev instance scales to zero, and an idle tab must not keep it
    // (and the database) awake. The one exception is below — a visibility refetch
    // while a payment holdoff is active — which is user-driven (a hidden tab fires
    // nothing) and saves the "pay on Shopify, come back, refresh by hand" step.
    const processId = s.process?.id;
    if (processId && s.process?.status === "PENDING_PAYMENT") {
      if (sessionStorage.getItem(awaitingPaymentKey(processId))) setAwaitingPayment({ processId });
    } else if (processId) {
      sessionStorage.removeItem(awaitingPaymentKey(processId));
      setAwaitingPayment(null);
    }
    resetForm(s.prefill);
  }, [resetForm]);

  const fetchState = useCallback(() =>
    fetch("/api/membership")
      .then(async (res) => { if (res.ok) hydrate(await res.json()); })
      .catch(() => { /* shown via empty state */ })
      .finally(() => setLoading(false)), [hydrate]);

  const load = useCallback(() => {
    setLoading(true);
    return fetchState();
  }, [fetchState]);

  // Return from embedded signing: Zoho redirects back with ?signed=1 (or
  // ?declined=1). Sync the contract status straight from Zoho rather than waiting
  // on the inbound webhook (ops-dev is scale-to-zero and may be asleep when Zoho
  // fires it), refresh, then strip the query so a manual reload doesn't re-run.
  const signReturnHandled = useRef(false);
  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    let declined = false;
    if (!signReturnHandled.current) {
      const params = new URLSearchParams(window.location.search);
      const signed = params.get("signed") === "1";
      declined = params.get("declined") === "1";
      if (signed || declined) {
        signReturnHandled.current = true;
        window.history.replaceState(null, "", window.location.pathname);
      }
      if (signed) {
        (async () => {
          let signedNow = false;
          try {
            const res = await fetch("/api/membership/contract/sync", { method: "POST" });
            const data = await res.json().catch(() => null);
            signedNow = !!data?.status?.contractSigned;
          } catch {
            /* best-effort — the Zoho webhook is still a backstop */
          }
          await load();
          notifications.show({
            message: signedNow
              ? "Thanks — your signature was received."
              : "Signature received — finalizing. If it doesn't update shortly, use “Refresh status”.",
          });
        })();
      }
    }
    // The page shows the loader until this first load settles, so the decline
    // message lands with the first visible render.
    fetchState().then(() => {
      if (declined) setMessage({ text: "You declined the agreement. You can restart signing when you're ready.", tone: "error" });
    });
  }, [sessionStatus, fetchState, load]);

  // When awaiting payment, fetch the membership-fee amount and Shopify checkout link. Leads
  // only — the route refuses anyone else, and the card hides the money from them.
  useEffect(() => {
    if (state?.process?.status !== "PENDING_PAYMENT" || !state.isLead) return;
    let cancelled = false;
    fetch("/api/membership/payment")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancelled && data) setPayment(data); })
      .catch(() => { /* shown as link-unavailable */ });
    return () => { cancelled = true; };
  }, [state?.process?.status, state?.isLead]);

  // Returning from the Shopify checkout tab: refetch once when this tab becomes
  // visible again, ONLY while a payment holdoff is active — so the paid state
  // appears without a manual refresh. Event-driven, not polling: a hidden or
  // idle tab triggers nothing (see the no-polling note above).
  useEffect(() => {
    if (!awaitingPayment) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [awaitingPayment, load]);

  const flash = (msg: string, error = false) => {
    setMessage(msg ? { text: msg, tone: error ? "error" : "success" } : undefined);
    // Clear stale warnings when starting an action (msg === "") or on a hard
    // failure; a successful save sets them right after this call.
    if (error || msg === "") setWarnings([]);
  };

  // Real Shopify checkout only (opens a new tab) — starts the payment holdoff.
  // The local mock settles synchronously and never needs one.
  const handlePayClick = () => {
    if (!state?.process) return;
    sessionStorage.setItem(awaitingPaymentKey(state.process.id), "1");
    setAwaitingPayment({ processId: state.process.id });
  };

  const onMockPaid = async () => {
    flash("Payment mocked (local) — updating status.");
    notifyNavRefresh();
    await load();
  };
  const onMockFailed = (data: { error?: string; detail?: string } | null) =>
    flash(apiError(data, "Mock payment failed."), true);

  // Clear a single field's error (called as the user edits it).
  const clearErr = (key: string) =>
    setFieldErrors((fe) => (fe[key] ? Object.fromEntries(Object.entries(fe).filter(([k]) => k !== key)) : fe));

  const startApplication = async () => {
    setSaving(true);
    flash("");
    try {
      const res = await fetch("/api/membership", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { hydrate(data.state); notifyNavRefresh(); }
      else flash(apiError(data, "Could not start your application."), true);
    } catch {
      networkError();
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    flash("");
    try {
      const res = await fetch("/api/membership/intake", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildIntakePayload(form.values)),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        hydrate(data.state);
        flash("Progress saved.");
        setWarnings((data.rejections ?? []).map((r: { message: string }) => r.message));
      } else flash(apiError(data, "Could not save."), true);
    } catch {
      networkError();
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    // Highlight missing required fields up front — instant feedback, no round-trip.
    const errs = validateIntake(form.values);
    setFieldErrors(errs);
    if (Object.keys(errs).length) {
      flash("Please complete the highlighted fields.", true);
      return;
    }

    setSaving(true);
    flash("");
    try {
      // Persist latest edits first, then advance.
      const saveRes = await fetch("/api/membership/intake", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildIntakePayload(form.values)),
      });
      const saveData = await saveRes.json();
      if (!saveRes.ok) {
        // The save can reject a field the client can't check locally (e.g. an
        // emergency contact who is also a household member) — highlight it.
        if (saveData.fields) setFieldErrors(mapServerFields(saveData.fields));
        flash(apiError(saveData, "Could not save."), true);
        return;
      }
      const saveWarnings: string[] = (saveData.rejections ?? []).map((r: { message: string }) => r.message);
      const res = await fetch("/api/membership/intake/submit", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setFieldErrors({});
        hydrate(data.state);
        notifyNavRefresh();
        flash("Submitted! Next: sign your contract and start your background check — then you can pay right away.");
        setWarnings(saveWarnings);
      } else if (data.code === "no_process") {
        // Race: the process advanced out from under this stale view. Transient
        // toast + re-hydrate; the `incomplete` field-error path below is untouched.
        notifications.show({ color: "red", message: data.error || "No application is awaiting your information.", autoClose: 4000 });
        await load();
      } else {
        // The server may flag fields the client can't check locally (e.g. an
        // emergency contact who is a household member) — highlight those too.
        if (data.fields) setFieldErrors(mapServerFields(data.fields));
        flash(apiError(data, "Could not submit."), true);
      }
    } catch {
      networkError();
    } finally {
      setSaving(false);
    }
  };

  // "Sign your membership agreement" — create/reuse the Zoho request and go
  // straight into the embedded signing ceremony. The contract task flips to ✓
  // automatically (Zoho webhook) when the applicant returns signed.
  const startSigning = async () => {
    setSaving(true);
    flash("");
    try {
      const res = await fetch("/api/membership/contract/sign", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        window.location.href = data.url;
      } else if (data.code === "not_configured" || data.code === "agreement_unavailable") {
        // Zoho e-sign isn't set up yet (503) — retrying won't help.
        flash("Signing is temporarily unavailable — please check back soon.", true);
        setSaving(false);
      } else {
        flash(apiError(data, "Couldn't open the signing form. Please try again."), true);
        setSaving(false);
      }
    } catch {
      networkError();
      setSaving(false);
    }
    // On success we navigate away, so we intentionally leave `saving` true.
  };

  // Ask the board's Scholarship Review Team for a payment plan on the membership fee.
  // Mirrors the program-page request; the finance-ops Membership Payment Plan tab
  // picks it up and activates the membership on approval (no Shopify payment).
  // Mirrors the server flag both ways (not just true->true) so a denial that
  // clears isPaymentPlanRequested — surfaced on the next state refetch — reverts
  // the button to requestable instead of latching "requested" forever. The
  // request button's own optimistic setPlanRequested(true) after a successful
  // POST (below) is untouched by this: it doesn't change the server flag, so this
  // sync doesn't re-run and clobber it.
  const serverPlanRequested = !!state?.process?.isPaymentPlanRequested;
  const [seenServerPlanRequested, setSeenServerPlanRequested] = useState(serverPlanRequested);
  if (serverPlanRequested !== seenServerPlanRequested) {
    setSeenServerPlanRequested(serverPlanRequested);
    setPlanRequested(serverPlanRequested);
  }

  const requestPaymentPlan = async () => {
    if (!planKind) return;
    closeConfirmPlan();
    if (!state?.process) return;
    try {
      const res = await fetch("/api/membership/request-payment-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId: state.process.id, kind: planKind }),
      });
      if (res.ok) {
        setPlanRequested(true);
        notifications.show({ message: "Requested! The Scholarship Review Team will follow up." });
      } else {
        const data = await res.json().catch(() => ({}));
        notifications.show({ color: "red", message: data.error || "Could not request a payment plan.", autoClose: false });
      }
    } catch {
      networkError();
    }
  };

  const renew = async () => {
    setSaving(true);
    flash("");
    try {
      const res = await fetch("/api/membership/renew", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { await load(); notifyNavRefresh(); flash("Renewal started."); }
      else if (data.code === "wrong_phase") {
        notifications.show({ color: "red", message: data.error || "This renewal is no longer awaiting your confirmation.", autoClose: 4000 });
        await load();
      }
      else flash(apiError(data, "Could not start renewal."), true);
    } catch {
      networkError();
    } finally {
      setSaving(false);
    }
  };

  // Applicant confirms they submitted consent on Averity. On success the reload
  // flips the task to done (and may advance the whole card to payment); on
  // failure the checkbox reverts so they can retry.
  const recordBgConsent = async () => {
    setBgConsenting(true);
    try {
      const res = await fetch("/api/membership/bg-consent", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        await load();
        notifyNavRefresh();
      } else {
        setBgConsenting(false);
        flash(apiError(data, "Could not record your consent. Please try again."), true);
      }
    } catch {
      setBgConsenting(false);
      networkError();
    }
  };

  useUnsavedGuard(form.isDirty);

  return {
    session, sessionStatus, state, loading, saving, setSaving, message, warnings, fieldErrors, clearErr, form,
    load, startApplication, save, submit, startSigning, renew,
    payment: {
      payment, awaitingPayment, clearAwaitingPayment, handlePayClick, onMockPaid, onMockFailed,
      planRequested, planKind, setPlanKind, confirmPlanOpened, openConfirmPlan, closeConfirmPlan, requestPaymentPlan,
    },
    bg: { linkOpened: bgLinkOpened, markLinkOpened: () => setBgLinkOpened(true), consenting: bgConsenting, recordConsent: recordBgConsent },
  };
}

export type PaymentControls = ReturnType<typeof useMembershipPage>["payment"];
export type BgConsentControls = ReturnType<typeof useMembershipPage>["bg"];
