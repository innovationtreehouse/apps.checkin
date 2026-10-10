"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import type { OrgMembershipProcessStatus, OrgMembershipStatus } from "@/generated/prisma/client";
import {
  Alert, Anchor, Box, Button, Card, Checkbox, Container, Group, Modal,
  Radio, SimpleGrid, Stack, Text, Textarea, TextInput, ThemeIcon, Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useDisclosure } from "@mantine/hooks";
import { AlertBanner, type AlertTone } from "@/components/admin/AlertBanner";
import MembershipFlowStepper from "@/components/MembershipFlowStepper";
import { notifyNavRefresh } from "@/lib/nav-refresh";
import { pickAddress, type StructuredAddress } from "@/lib/address";
import { isValidEmail } from "@/lib/emergencyContacts/identity";
import { isValidPhone, PHONE_ERROR } from "@/lib/phone";
import { useUnsavedGuard, useConfirmNav } from "@/components/UnsavedChangesProvider";
import AddressForm from "@/components/membership/AddressForm";
import EmergencyContactForm from "@/components/membership/EmergencyContactForm";
import ChildrenListForm from "@/components/membership/ChildrenListForm";
import { useIsLocalInstance } from "@/components/EnvProvider";
import { SCHOLARSHIP_REQUEST_KIND_OPTIONS } from "@/lib/scholarshipRequestKind";

import { PageLoader } from "@/components/ui/PageLoader";
const blankAddress: StructuredAddress = { line1: "", line2: "", city: "", state: "", postalCode: "" };

// Payment holdoff (below): sessionStorage key for the awaiting-payment record
// set by a real Shopify checkout click.
const awaitingPaymentKey = (processId: number) => `membership_awaiting_payment_${processId}`;

interface PersonPrefill {
  id: number;
  name: string | null;
  email: string | null;
  dob: string | null;
  over25: boolean;
  allergies: string | null;
}

interface ExternalStatus {
  contractSigned: boolean;
  contractStarted: boolean;
  bgConsented: boolean;
  bgCleared: boolean;
  deepLinkUrl: string | null;
}

interface IntakeState {
  hasHousehold: boolean;
  isLead: boolean;
  membershipStatus: OrgMembershipStatus | null;
  process: { id: number; kind: string; status: OrgMembershipProcessStatus; isPaymentPlanRequested?: boolean } | null;
  external: ExternalStatus | null;
  /** The caller's own unsigned individual agreement, independent of the household's. */
  personAgreement: { id: number; started: boolean } | null;
  prefill: {
    household: ({ name: string | null; notes: string | null; emergencyContactName: string | null; emergencyContactPhone: string | null; emergencyContactEmail: string | null } & Partial<StructuredAddress>) | null;
    primaryParent: PersonPrefill | null;
    secondaryParent: PersonPrefill | null;
    children: PersonPrefill[];
  };
}

interface ChildForm {
  id?: number;
  name: string;
  email: string;
  dob: string;
  allergies: string;
}

interface FormValues {
  address: StructuredAddress;
  emName: string; emPhone: string; emEmail: string;
  primaryName: string; primaryDob: string; primaryOver25: boolean; primaryAllergies: string;
  hasSecondary: boolean; secondaryId?: number;
  secondaryName: string; secondaryEmail: string; secondaryDob: string; secondaryOver25: boolean; secondaryAllergies: string;
  children: ChildForm[];
  notes: string;
}

// Stable key for the unsaved-changes dirty compare. Array (not object) so order
// is deterministic, and nested — children/address rule out the flat shallowEqual.
export const serializeMembershipForm = (v: FormValues) =>
  JSON.stringify([
    v.address.line1, v.address.line2, v.address.city, v.address.state, v.address.postalCode,
    v.emName, v.emPhone, v.emEmail,
    v.primaryName, v.primaryDob, v.primaryOver25, v.primaryAllergies,
    v.hasSecondary, v.secondaryId, v.secondaryName, v.secondaryEmail, v.secondaryDob, v.secondaryOver25, v.secondaryAllergies,
    v.children.map((c) => [c.id, c.name, c.email, c.dob, c.allergies]),
    v.notes,
  ]);

function ExternalTask({ done, title, doneText, doneExtra, children }: { done: boolean; title: string; doneText: string; doneExtra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card withBorder radius="md" padding="md" bg={done ? "var(--mantine-color-green-light)" : undefined}>
      <Group align="flex-start" wrap="nowrap">
        <ThemeIcon color={done ? "treehouseGreen" : "gray"} radius="xl" size="md" variant={done ? "filled" : "light"}>
          {done ? "✓" : "•"}
        </ThemeIcon>
        <Box style={{ flex: 1 }}>
          <Text fw={600} mb="xs">{title}</Text>
          {done ? (
            <>
              <Text c="green">{doneText}</Text>
              {doneExtra}
            </>
          ) : children}
        </Box>
      </Group>
    </Card>
  );
}

export default function MembershipPage() {
  const { data: session, status: sessionStatus } = useSession();
  const isLocalInstance = useIsLocalInstance();

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

  // Intake form fields
  const [address, setAddress] = useState<StructuredAddress>(blankAddress);
  const [emName, setEmName] = useState("");
  const [emPhone, setEmPhone] = useState("");
  const [emEmail, setEmEmail] = useState("");
  const [primaryName, setPrimaryName] = useState("");
  const [primaryDob, setPrimaryDob] = useState("");
  const [primaryOver25, setPrimaryOver25] = useState(false);
  const [primaryAllergies, setPrimaryAllergies] = useState("");
  const [hasSecondary, setHasSecondary] = useState(false);
  const [secondaryId, setSecondaryId] = useState<number | undefined>(undefined);
  const [secondaryName, setSecondaryName] = useState("");
  const [secondaryEmail, setSecondaryEmail] = useState("");
  const [secondaryDob, setSecondaryDob] = useState("");
  const [secondaryOver25, setSecondaryOver25] = useState(false);
  const [secondaryAllergies, setSecondaryAllergies] = useState("");
  const [children, setChildren] = useState<ChildForm[]>([]);
  const [notes, setNotes] = useState("");
  const [payment, setPayment] = useState<{ amountCents: number; checkoutUrl: string | null } | null>(null);
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
  // Serialized form as last loaded/saved; isDirty compares it to current state.
  const [savedForm, setSavedForm] = useState<string | null>(null);

  // Drop the holdoff and its sessionStorage record — the "Show the payment
  // button again" escape hatch for an abandoned checkout.
  const clearAwaitingPayment = useCallback(() => {
    setAwaitingPayment((cur) => {
      if (cur) sessionStorage.removeItem(awaitingPaymentKey(cur.processId));
      return null;
    });
  }, []);

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
    const h = s.prefill.household;
    const a = pickAddress(h);
    const address = { line1: a.line1 ?? "", line2: a.line2 ?? "", city: a.city ?? "", state: a.state ?? "", postalCode: a.postalCode ?? "" };
    setAddress(address);
    setEmName(h?.emergencyContactName ?? "");
    setEmPhone(h?.emergencyContactPhone ?? "");
    setEmEmail(h?.emergencyContactEmail ?? "");
    setNotes(h?.notes ?? "");
    const p = s.prefill.primaryParent;
    setPrimaryName(p?.name ?? "");
    setPrimaryDob(p?.dob ?? "");
    setPrimaryOver25(!!p?.over25);
    setPrimaryAllergies(p?.allergies ?? "");
    const sec = s.prefill.secondaryParent;
    if (sec) {
      setHasSecondary(true);
      setSecondaryId(sec.id);
      setSecondaryName(sec.name ?? "");
      setSecondaryEmail(sec.email ?? "");
      setSecondaryDob(sec.dob ?? "");
      setSecondaryOver25(!!sec.over25);
      setSecondaryAllergies(sec.allergies ?? "");
    }
    const nextChildren = s.prefill.children.map((c) => ({
      id: c.id,
      name: c.name ?? "",
      email: c.email ?? "",
      dob: c.dob ?? "",
      allergies: c.allergies ?? "",
    }));
    setChildren(nextChildren);
    // Snapshot the just-loaded values so isDirty starts false (state setters
    // above haven't applied yet, so derive the snapshot straight from `s`).
    setSavedForm(serializeMembershipForm({
      address,
      emName: h?.emergencyContactName ?? "",
      emPhone: h?.emergencyContactPhone ?? "",
      emEmail: h?.emergencyContactEmail ?? "",
      primaryName: p?.name ?? "",
      primaryDob: p?.dob ?? "",
      primaryOver25: !!p?.over25,
      primaryAllergies: p?.allergies ?? "",
      hasSecondary: !!sec,
      secondaryId: sec?.id,
      secondaryName: sec?.name ?? "",
      secondaryEmail: sec?.email ?? "",
      secondaryDob: sec?.dob ?? "",
      secondaryOver25: !!sec?.over25,
      secondaryAllergies: sec?.allergies ?? "",
      children: nextChildren,
      notes: h?.notes ?? "",
    }));
  }, []);

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

  // Build an error message from an API response, appending the dev-only `detail`
  // (the real server failure) when present so an "Internal Server Error" isn't a
  // dead end. Falls back to a friendly default when the body carries nothing.
  const apiError = (data: { error?: string; detail?: string } | null | undefined, fallback: string) =>
    [data?.error, data?.detail].filter(Boolean).join(" — ") || fallback;

  // Real Shopify checkout only (opens a new tab) — starts the payment holdoff.
  // The local mock below settles synchronously and never needs one.
  const handlePayClick = () => {
    if (!state?.process) return;
    sessionStorage.setItem(awaitingPaymentKey(state.process.id), "1");
    setAwaitingPayment({ processId: state.process.id });
  };

  // Local dev has no Shopify store, so instead of a checkout redirect we fire the
  // mock orders/paid webhook in-app (same endpoint the Debug → Shopify tool uses),
  // settling the membership fee end-to-end with zero setup. Only rendered on a local instance.
  const settleMockPayment = async () => {
    if (!state?.process) return;
    setSaving(true);
    try {
      const res = await fetch("/api/dev/shopify/orders-paid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId: state.process.id }),
      });
      if (res.ok) {
        flash("Payment mocked (local) — updating status.");
        notifyNavRefresh();
        await load();
      } else {
        flash(apiError(await res.json().catch(() => null), "Mock payment failed."), true);
      }
    } catch {
      flash("Mock payment failed.", true);
    } finally {
      setSaving(false);
    }
  };

  // Clear a single field's error (called as the user edits it).
  const clearErr = (key: string) =>
    setFieldErrors((fe) => (fe[key] ? Object.fromEntries(Object.entries(fe).filter(([k]) => k !== key)) : fe));

  // Required-field check for submit, mirroring the server's rules so the user
  // gets instant red-box feedback on every environment (no round-trip needed).
  const validateIntake = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!address.line1?.trim()) errs.address = "Home address is required.";
    if (!address.city?.trim()) errs.addrCity = "City is required.";
    if (!address.state?.trim()) errs.addrState = "State is required.";
    if (!address.postalCode?.trim()) errs.addrZip = "ZIP is required.";
    if (!emName.trim()) errs.emName = "Emergency contact name is required.";
    if (!emPhone.trim()) errs.emPhone = "Emergency contact phone is required.";
    else if (!isValidPhone(emPhone)) errs.emPhone = PHONE_ERROR;
    if (emEmail.trim() && !isValidEmail(emEmail)) errs.emEmail = "That email address doesn't look right.";
    if (!primaryName.trim()) errs.primaryName = "Your name is required.";
    return errs;
  };

  // Map the server's field keys (from an `incomplete` submit) onto form inputs —
  // covers cases the client can't detect locally (e.g. an emergency contact that
  // is itself a household member).
  const mapServerFields = (fields?: string[]): Record<string, string> => {
    const errs: Record<string, string> = {};
    for (const f of fields ?? []) {
      if (f === "address") errs.address = "Home address is required.";
      else if (f === "primaryName") errs.primaryName = "Your name is required.";
      else if (f === "emergencyContact") {
        errs.emName = "Add an emergency contact who isn't in your household.";
        errs.emPhone = "Add an emergency contact who isn't in your household.";
      }
    }
    return errs;
  };

  const startApplication = async () => {
    setSaving(true);
    flash("");
    try {
      const res = await fetch("/api/membership", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { hydrate(data.state); notifyNavRefresh(); }
      else flash(apiError(data, "Could not start your application."), true);
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setSaving(false);
    }
  };

  const buildPayload = () => ({
    household: { ...address, emergencyContactName: emName, emergencyContactPhone: emPhone, emergencyContactEmail: emEmail, notes: notes || null },
    primaryParent: { name: primaryName, dob: primaryOver25 ? null : (primaryDob || null), over25: primaryOver25, allergies: primaryAllergies || null },
    secondaryParent: hasSecondary
      ? { id: secondaryId, name: secondaryName, email: secondaryEmail || undefined, dob: secondaryOver25 ? null : (secondaryDob || null), over25: secondaryOver25, allergies: secondaryAllergies || null }
      : null,
    children: children
      .filter((c) => c.name.trim())
      .map((c) => ({ id: c.id, name: c.name, email: c.email || null, dob: c.dob || null, allergies: c.allergies || null })),
  });

  const save = async () => {
    setSaving(true);
    flash("");
    try {
      const res = await fetch("/api/membership/intake", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        hydrate(data.state);
        flash("Progress saved.");
        setWarnings((data.rejections ?? []).map((r: { message: string }) => r.message));
      } else flash(apiError(data, "Could not save."), true);
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    // Highlight missing required fields up front — instant feedback, no round-trip.
    const errs = validateIntake();
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
        body: JSON.stringify(buildPayload()),
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
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
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
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
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
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
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
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
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
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    }
  };

  const addChild = () => setChildren((c) => [...c, { name: "", email: "", dob: "", allergies: "" }]);
  const updateChild = (i: number, field: keyof ChildForm, value: string) =>
    setChildren((c) => c.map((child, idx) => (idx === i ? { ...child, [field]: value } : child)));
  const removeChild = (i: number) => setChildren((c) => c.filter((_, idx) => idx !== i));

  const currentForm = serializeMembershipForm({
    address, emName, emPhone, emEmail,
    primaryName, primaryDob, primaryOver25, primaryAllergies,
    hasSecondary, secondaryId, secondaryName, secondaryEmail, secondaryDob, secondaryOver25, secondaryAllergies,
    children,
    notes,
  });
  // Dirty once the user edits past the loaded snapshot. Re-hydrate after a
  // save/submit re-snapshots, so this flips back to false then.
  const isDirty = savedForm !== null && currentForm !== savedForm;
  useUnsavedGuard(isDirty);
  const confirmNav = useConfirmNav();

  if (sessionStatus === "loading" || (loading && sessionStatus === "authenticated")) {
    return <PageLoader />;
  }

  if (!session?.user) {
    return (
      <Container size="xs" py="xl">
        <Card withBorder radius="md" padding="xl" ta="center">
          <Title order={1}>Join the Treehouse</Title>
          <Text c="dimmed" my="md">Please sign in to start your membership application.</Text>
          <Button component={Link} href="/">Go to sign in</Button>
        </Card>
      </Container>
    );
  }

  const inStatus = state?.process?.status ?? null;
  const isIntake = inStatus === "INTAKE";
  const isActive = state?.membershipStatus === "ACTIVE";
  const isRenewal = state?.process?.kind === "RENEWAL";
  // Steps whose every action is the lead's — household details, contract signing,
  // background-check consent, dues and checkout. Each backing route refuses a
  // non-lead, so rendering the controls for one would only produce a 403.
  const isLeadOnlyStep = isIntake || inStatus === "PENDING_EXTERNAL_ACTION" || inStatus === "PENDING_PAYMENT";

  return (
    <Container size="lg" pb="md">
      <Group justify="space-between" align="center" wrap="wrap" mb="lg">
        <Title order={1}>Treehouse Membership</Title>
        <Button component={Link} href="/" variant="default" onNavigate={(e) => { if (!confirmNav()) e.preventDefault(); }}>← Home</Button>
      </Group>

      {/* Intake echoes `message` in a section-local Alert next to its buttons
          (long card), so suppress the top banner there to avoid a duplicate. */}
      <AlertBanner message={isIntake ? undefined : message?.text} tone={message?.tone} mb="lg" />

      {warnings.length > 0 && (
        <Alert color="yellow" mb="lg" title="Saved — with a couple of things to know">
          <Stack gap="xs">
            {warnings.map((w, i) => <Text key={i} size="sm">{w}</Text>)}
          </Stack>
        </Alert>
      )}

      {/* Your own agreement, not your household's — an adult can't be bound by a
          parent's signature. Rendered above the household flow and independent of it:
          the subject is usually a non-lead in a settled member household, where every
          branch below shows "you're a member" and nothing else. */}
      {state?.personAgreement && (
        <Card withBorder radius="md" padding="lg" mb="lg" maw={640}>
          <Title order={2}>Sign your individual membership agreement</Title>
          <Text c="dimmed" my="md">
            You&apos;re 18 or older, so you sign your own membership agreement rather than
            being covered by your household&apos;s. Have your insurance details handy — the
            agreement asks for your provider and policy number.
          </Text>
          <Button disabled={saving} loading={saving} onClick={startSigning}>
            {state.personAgreement.started ? "Resume signing →" : "Sign your agreement →"}
          </Button>
        </Card>
      )}

      {!state?.process ? (
        isActive ? (
          <Card withBorder radius="md" padding="xl">
            <Title order={2}>You&apos;re a member 🎉</Title>
            <Text c="dimmed" mt="sm">Your household membership is active. Thank you for being part of the Treehouse!</Text>
          </Card>
        ) : (
          <Card withBorder radius="md" padding="xl" maw={640}>
            <Title order={2}>Become a member</Title>
            <Text c="dimmed" my="md">
              Membership is for your whole household. We&apos;ll collect some information about your
              family, then walk you through signing a contract, a background check, and payment. You
              can stop and resume anytime.
            </Text>
            {state?.isLead ? (
              <Button disabled={saving} loading={saving} onClick={startApplication}>Start application</Button>
            ) : (
              <Text c="dimmed">Only a household lead can start the membership application. Ask your household&apos;s lead to begin.</Text>
            )}
          </Card>
        )
      ) : isRenewal && inStatus === "PENDING_RENEWAL" && !state.isLead ? (
        <Card withBorder radius="md" padding="xl" maw={640}>
          <Title order={2}>Your household is up for renewal</Title>
          <Text c="dimmed" mt="sm">
            Your household lead will confirm the renewal — nothing for you to do right now. Your
            membership stays active in the meantime.
          </Text>
        </Card>
      ) : isRenewal && inStatus === "PENDING_RENEWAL" ? (
        <Card withBorder radius="md" padding="xl" maw={640}>
          <Title order={2}>Time to renew</Title>
          <Text c="dimmed" my="md">
            Your household membership is up for renewal. You&apos;re still an active member — confirm
            below to continue for another year. You&apos;ll sign a fresh membership agreement; a new
            background check is only needed if your previous one has expired.
          </Text>
          <Text c="dimmed" mb="md">
            Did anything change — new members, address, phone, or email?{" "}
            <Anchor component={Link} href="/my-household">Update your household details first</Anchor>.
          </Text>
          <Button disabled={saving} loading={saving} onClick={renew}>Renew now</Button>
        </Card>
      ) : isRenewal && inStatus === "RENEWAL_PENDING_BG" ? (
        <Card withBorder radius="md" padding="xl" maw={640}>
          <Title order={2}>Renewal in progress</Title>
          <Text c="dimmed" mt="md">
            We&apos;re re-confirming your household&apos;s background check (the previous one has
            expired). You&apos;ll be able to pay once that&apos;s done. Your membership stays active
            in the meantime.
          </Text>
        </Card>
      ) : (
        <Group align="flex-start" gap="xl" wrap="wrap">
          {/* Renewals ride the same stepper as new applications — same phases, same
              progress, whether the background check is valid, expired, or first-time. */}
          <Box style={{ flex: "0 1 auto", maxWidth: "100%", overflowX: "auto" }}>
            <MembershipFlowStepper currentStatus={inStatus} />
          </Box>

          <Box style={{ flex: "1 1 420px", minWidth: "min(320px, 100%)" }}>
            {!state.isLead && isLeadOnlyStep ? (
              <Card withBorder radius="md" padding="lg">
                <Title order={2} mb="sm">Membership application in progress</Title>
                <Text c="dimmed">
                  Your household&apos;s membership application is in progress. Your household lead
                  will complete it — nothing for you to do right now.
                </Text>
              </Card>
            ) : isIntake ? (
              <Card withBorder radius="md" padding="lg">
                <Stack gap="lg">
                  <section>
                    <Title order={2} mb="sm">Your household</Title>
                    <AddressForm
                      address={address}
                      onChange={setAddress}
                      errors={{ line1: fieldErrors.address, city: fieldErrors.addrCity, state: fieldErrors.addrState, postalCode: fieldErrors.addrZip }}
                      onErrorClear={(f) => clearErr(f === "line1" ? "address" : f === "city" ? "addrCity" : f === "state" ? "addrState" : "addrZip")}
                    />
                    <EmergencyContactForm
                      emName={emName} setEmName={setEmName}
                      emPhone={emPhone} setEmPhone={setEmPhone}
                      emEmail={emEmail} setEmEmail={setEmEmail}
                      errors={fieldErrors}
                      clearErr={clearErr}
                    />
                  </section>

                  <section>
                    <Title order={2} mb="sm">Primary parent / guardian</Title>
                    <TextInput label="Full name" description="Printed on name badges exactly as typed — please double-check the spelling." value={primaryName} error={fieldErrors.primaryName} onChange={(e) => { setPrimaryName(e.currentTarget.value); clearErr("primaryName"); }} />
                    <Checkbox
                      mt="md"
                      label="Individual is over 25"
                      checked={primaryOver25}
                      onChange={(e) => { setPrimaryOver25(e.currentTarget.checked); if (e.currentTarget.checked) setPrimaryDob(""); }}
                    />
                    <SimpleGrid cols={{ base: 1, sm: 2 }} mt="md">
                      {!primaryOver25 && (
                        <TextInput type="date" label="Date of birth" value={primaryDob} onChange={(e) => setPrimaryDob(e.currentTarget.value)} />
                      )}
                      <TextInput label="Allergies (optional)" value={primaryAllergies} onChange={(e) => setPrimaryAllergies(e.currentTarget.value)} />
                    </SimpleGrid>
                  </section>

                  <section>
                    <Checkbox
                      checked={hasSecondary}
                      onChange={(e) => setHasSecondary(e.currentTarget.checked)}
                      label="Add a second parent / guardian"
                    />
                    {hasSecondary && (
                      <Stack mt="sm">
                        <TextInput label="Full name" description="Printed on name badges exactly as typed — please double-check the spelling." value={secondaryName} onChange={(e) => setSecondaryName(e.currentTarget.value)} />
                        <Checkbox
                          label="Individual is over 25"
                          checked={secondaryOver25}
                          onChange={(e) => { setSecondaryOver25(e.currentTarget.checked); if (e.currentTarget.checked) setSecondaryDob(""); }}
                        />
                        <SimpleGrid cols={{ base: 1, sm: 2 }}>
                          <TextInput type="email" label="Email (optional)" value={secondaryEmail} onChange={(e) => setSecondaryEmail(e.currentTarget.value)} />
                          {!secondaryOver25 && (
                            <TextInput type="date" label="Date of birth" value={secondaryDob} onChange={(e) => setSecondaryDob(e.currentTarget.value)} />
                          )}
                        </SimpleGrid>
                        <TextInput label="Allergies (optional)" value={secondaryAllergies} onChange={(e) => setSecondaryAllergies(e.currentTarget.value)} />
                      </Stack>
                    )}
                  </section>

                  <ChildrenListForm items={children} onAdd={addChild} onUpdate={updateChild} onRemove={removeChild} />

                  <section>
                    <Textarea
                      label="Anything else we should know?"
                      description="Optional. Tell us anything that would help us review your application — for example, if your household is applying to volunteer only, with no students enrolled."
                      autosize
                      minRows={3}
                      value={notes}
                      onChange={(e) => setNotes(e.currentTarget.value)}
                    />
                  </section>

                  {/* Local echo of the page-top banner: intake is a long card, so
                      the top AlertBanner posts off-screen next to these buttons. */}
                  {message && (
                    <Alert color={message.tone === "error" ? "red" : "treehouseGreen"} variant="light">
                      {message.text}
                    </Alert>
                  )}

                  <Group gap="md" wrap="wrap">
                    <Button variant="default" disabled={saving} loading={saving} onClick={save}>Save progress</Button>
                    <Button disabled={saving} loading={saving} onClick={submit}>Submit &amp; continue</Button>
                  </Group>
                </Stack>
              </Card>
            ) : inStatus === "PENDING_EXTERNAL_ACTION" ? (
              <Card withBorder radius="md" padding="lg">
                <Stack gap="md">
                  <div>
                    <Title order={2}>Sign &amp; start your background check</Title>
                    <Text c="dimmed">
                      {isRenewal
                        ? "Renewing means signing a fresh membership agreement for the year, and a new background check if your previous one has expired. Once both are underway, we'll move you straight to payment — your membership stays active in the meantime."
                        : "Once your agreement is signed and your background check is underway, we'll move you straight to payment — you won't have to wait for the background check to come back."}
                    </Text>
                  </div>

                  <ExternalTask done={!!state.external?.contractSigned} title="Sign your membership agreement" doneText="Agreement signed — thank you!">
                    <Stack gap="xs" align="flex-start">
                      <Text c="dimmed">
                        Sign your personalized membership agreement online. This page updates
                        automatically once it&apos;s signed. Have your insurance details handy — the
                        agreement asks for your provider and policy number.
                      </Text>
                      <Button disabled={saving} loading={saving} onClick={startSigning}>
                        {state.external?.contractStarted ? "Resume signing →" : "Sign your membership agreement →"}
                      </Button>
                    </Stack>
                  </ExternalTask>

                  {state.external?.bgCleared ? (
                    <ExternalTask done title="Background check" doneText="Your household&apos;s background check is still valid — no new check needed.">
                      <Text c="dimmed" />
                    </ExternalTask>
                  ) : (
                    <ExternalTask
                      done={!!state.external?.bgConsented}
                      title="Start your background check"
                      doneText="Background check started — we&apos;ll finish it in the background."
                      doneExtra={state.external?.deepLinkUrl ? (
                        <Text size="sm" c="dimmed" mt="xs">
                          Checked it by mistake, or still need to finish the form?{" "}
                          <Anchor href={state.external.deepLinkUrl} target="_blank" rel="noopener noreferrer">
                            Reopen the Averity consent form →
                          </Anchor>
                        </Text>
                      ) : undefined}
                    >
                      <Stack gap="xs" align="flex-start">
                        <Text c="dimmed">
                          Consent to your background check on Averity. It runs in the background — you
                          can keep going and pay while it completes.
                        </Text>
                        {state.external?.deepLinkUrl ? (
                          <>
                            <Button
                              component="a"
                              href={state.external.deepLinkUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={() => setBgLinkOpened(true)}
                            >
                              Consent on Averity →
                            </Button>
                            <Checkbox
                              label="I submitted my consent on Averity"
                              description={bgLinkOpened ? undefined : "Open the Averity form above first, then confirm here."}
                              checked={bgConsenting}
                              disabled={!bgLinkOpened || bgConsenting}
                              onChange={(e) => { if (e.currentTarget.checked) recordBgConsent(); }}
                            />
                          </>
                        ) : (
                          <Text c="dimmed">The background-check link isn&apos;t available yet. Please check back shortly.</Text>
                        )}
                      </Stack>
                    </ExternalTask>
                  )}

                  <Button variant="default" disabled={saving} onClick={load} style={{ alignSelf: "flex-start" }}>
                    Refresh status
                  </Button>
                </Stack>
              </Card>
            ) : inStatus === "PENDING_PAYMENT" ? (
              <Card withBorder radius="md" padding="lg">
                <Title order={2} mb="sm">Membership dues</Title>
                {payment ? (
                  <>
                    <Text c="dimmed">
                      Your annual household dues are <strong>${(payment.amountCents / 100).toFixed(2)}</strong>.
                    </Text>
                    {awaitingPayment ? (
                      <Stack gap="xs" mt="md" align="flex-start">
                        <Text>
                          We&apos;ll update your status here when we receive your payment — refresh
                          this page after you finish checkout.
                        </Text>
                        <Anchor component="button" type="button" size="sm" c="dimmed" onClick={clearAwaitingPayment}>
                          Show the payment button again
                        </Anchor>
                      </Stack>
                    ) : payment.checkoutUrl ? (
                      <Button component="a" href={payment.checkoutUrl} target="_blank" rel="noopener noreferrer" mt="md" onClick={handlePayClick}>
                        Pay here with Shopify →
                      </Button>
                    ) : isLocalInstance ? (
                      <Button mt="md" disabled={saving} onClick={settleMockPayment}>
                        Pay now (local mock) →
                      </Button>
                    ) : (
                      <Text c="yellow" mt="md">The payment link isn&apos;t available yet. Please check back shortly.</Text>
                    )}
                    <Modal opened={confirmPlanOpened} onClose={closeConfirmPlan} title="Request a scholarship or payment plan?" centered>
                      <Text size="sm">
                        This sends your request to the board&apos;s Scholarship Review Team, who will review
                        your household&apos;s dues and follow up with you. You won&apos;t be charged
                        anything now, and you can still pay online at any time.
                      </Text>
                      <Radio.Group
                        mt="md"
                        value={planKind}
                        onChange={setPlanKind}
                        label="What would help?"
                        description="So the team opens the right conversation. Nothing here commits you to anything."
                      >
                        <Stack gap="xs" mt="xs">
                          {SCHOLARSHIP_REQUEST_KIND_OPTIONS.map((o) => (
                            <Radio key={o.value} value={o.value} label={o.label} description={o.description} />
                          ))}
                        </Stack>
                      </Radio.Group>
                      <Group justify="flex-end" mt="md">
                        <Button variant="default" onClick={closeConfirmPlan}>Cancel</Button>
                        <Button onClick={requestPaymentPlan} disabled={!planKind}>Send request</Button>
                      </Group>
                    </Modal>
                    {planRequested ? (
                      <Text c="green" mt="md">Scholarship or payment plan requested — the Scholarship Review Team will follow up.</Text>
                    ) : (
                      <Button
                        variant="light"
                        type="button"
                        mt="md"
                        onClick={openConfirmPlan}
                        styles={{ root: { height: 'auto', paddingBlock: 'var(--mantine-spacing-xs)' }, label: { whiteSpace: 'normal' } }}
                      >
                        Request a scholarship or payment plan from the Scholarship Review Team
                      </Button>
                    )}
                    {!state.external?.bgCleared && (
                      <Alert color="blue" variant="light" mt="md">
                        Your background check is being reviewed in the background — you can pay now.
                        Your membership activates as soon as both the payment and the check are done.
                      </Alert>
                    )}
                    <Text size="sm" c="dimmed" mt="md">
                      For any questions, please email{" "}
                      <Anchor href="mailto:finance@innovationtreehouse.org">finance@innovationtreehouse.org</Anchor>.
                    </Text>
                  </>
                ) : (
                  <Text c="dimmed">Preparing your invoice…</Text>
                )}
              </Card>
            ) : inStatus === "PENDING_BG_CLEARANCE" ? (
              <Card withBorder radius="md" padding="lg">
                <Title order={2} mb="sm">Payment received 🎉</Title>
                <Text c="dimmed">
                  Thanks — your dues are paid. We&apos;re just finishing your background check. Your
                  membership activates automatically the moment it clears, and we&apos;ll email you
                  then. Nothing else to do.
                </Text>
              </Card>
            ) : (
              <Card withBorder radius="md" padding="xl">
                <Title order={2}>Application in progress</Title>
                <Text c="dimmed" mt="sm">
                  Your information is in. Follow the steps on the left — the next stages (background
                  check and payment) will appear here as they open.
                </Text>
              </Card>
            )}
          </Box>
        </Group>
      )}
    </Container>
  );
}
