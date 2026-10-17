import { useCallback, useState } from "react";
import { pickAddress, type StructuredAddress } from "@/lib/address";
import { isValidEmail } from "@/lib/emergencyContacts/identity";
import { isValidPhone, PHONE_ERROR } from "@/lib/phone";

export interface PersonPrefill {
  id: number;
  name: string | null;
  email: string | null;
  dob: string | null;
  over25: boolean;
  allergies: string | null;
}

export interface HouseholdPrefill extends Partial<StructuredAddress> {
  name: string | null;
  notes: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactEmail: string | null;
}

export interface IntakePrefill {
  household: HouseholdPrefill | null;
  primaryParent: PersonPrefill | null;
  secondaryParent: PersonPrefill | null;
  children: PersonPrefill[];
}

/** One person's editable intake fields — the primary and second guardian and each child. */
export interface PersonFields {
  id?: number;
  name: string;
  email: string;
  dob: string;
  over25: boolean;
  allergies: string;
}

const blankAddress: StructuredAddress = { line1: "", line2: "", city: "", state: "", postalCode: "" };

export const blankPerson: PersonFields = { name: "", email: "", dob: "", over25: false, allergies: "" };

const personFromPrefill = (p: PersonPrefill | null): PersonFields => ({
  id: p?.id,
  name: p?.name ?? "",
  email: p?.email ?? "",
  dob: p?.dob ?? "",
  over25: !!p?.over25,
  allergies: p?.allergies ?? "",
});

export interface FormValues {
  address: StructuredAddress;
  emName: string; emPhone: string; emEmail: string;
  primary: PersonFields;
  hasSecondary: boolean;
  secondary: PersonFields;
  children: PersonFields[];
  notes: string;
}

// Stable key for the unsaved-changes dirty compare. Array (not object) so order
// is deterministic, and nested — children/address rule out the flat shallowEqual.
export const serializeMembershipForm = (v: FormValues) =>
  JSON.stringify([
    v.address.line1, v.address.line2, v.address.city, v.address.state, v.address.postalCode,
    v.emName, v.emPhone, v.emEmail,
    v.primary.name, v.primary.dob, v.primary.over25, v.primary.allergies,
    v.hasSecondary, v.secondary.id, v.secondary.name, v.secondary.email, v.secondary.dob, v.secondary.over25, v.secondary.allergies,
    v.children.map((c) => [c.id, c.name, c.email, c.dob, c.allergies]),
    v.notes,
  ]);

export function formFromPrefill(prefill: IntakePrefill): FormValues {
  const h = prefill.household;
  const a = pickAddress(h);
  return {
    address: { line1: a.line1 ?? "", line2: a.line2 ?? "", city: a.city ?? "", state: a.state ?? "", postalCode: a.postalCode ?? "" },
    emName: h?.emergencyContactName ?? "",
    emPhone: h?.emergencyContactPhone ?? "",
    emEmail: h?.emergencyContactEmail ?? "",
    primary: personFromPrefill(prefill.primaryParent),
    hasSecondary: !!prefill.secondaryParent,
    secondary: personFromPrefill(prefill.secondaryParent),
    children: prefill.children.map(personFromPrefill),
    notes: h?.notes ?? "",
  };
}

export const buildIntakePayload = (v: FormValues) => ({
  household: { ...v.address, emergencyContactName: v.emName, emergencyContactPhone: v.emPhone, emergencyContactEmail: v.emEmail, notes: v.notes || null },
  primaryParent: { name: v.primary.name, dob: v.primary.over25 ? null : (v.primary.dob || null), over25: v.primary.over25, allergies: v.primary.allergies || null },
  secondaryParent: v.hasSecondary
    ? { id: v.secondary.id, name: v.secondary.name, email: v.secondary.email || undefined, dob: v.secondary.over25 ? null : (v.secondary.dob || null), over25: v.secondary.over25, allergies: v.secondary.allergies || null }
    : null,
  children: v.children
    .filter((c) => c.name.trim())
    .map((c) => ({ id: c.id, name: c.name, email: c.email || null, dob: c.dob || null, allergies: c.allergies || null })),
});

// Required-field check for submit, mirroring the server's rules so the user
// gets instant red-box feedback on every environment (no round-trip needed).
export function validateIntake(v: FormValues): Record<string, string> {
  const errs: Record<string, string> = {};
  if (!v.address.line1?.trim()) errs.address = "Home address is required.";
  if (!v.address.city?.trim()) errs.addrCity = "City is required.";
  if (!v.address.state?.trim()) errs.addrState = "State is required.";
  if (!v.address.postalCode?.trim()) errs.addrZip = "ZIP is required.";
  if (!v.emName.trim()) errs.emName = "Emergency contact name is required.";
  if (!v.emPhone.trim()) errs.emPhone = "Emergency contact phone is required.";
  else if (!isValidPhone(v.emPhone)) errs.emPhone = PHONE_ERROR;
  if (v.emEmail.trim() && !isValidEmail(v.emEmail)) errs.emEmail = "That email address doesn't look right.";
  if (!v.primary.name.trim()) errs.primaryName = "Your name is required.";
  return errs;
}

// Map the server's field keys (from an `incomplete` submit) onto form inputs —
// covers cases the client can't detect locally (e.g. an emergency contact that
// is itself a household member).
export function mapServerFields(fields?: string[]): Record<string, string> {
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
}

/** The intake form's editable state plus its dirty flag against the last loaded snapshot. */
export function useMembershipForm() {
  const [address, setAddress] = useState<StructuredAddress>(blankAddress);
  const [emName, setEmName] = useState("");
  const [emPhone, setEmPhone] = useState("");
  const [emEmail, setEmEmail] = useState("");
  const [primary, setPrimary] = useState<PersonFields>(blankPerson);
  const [hasSecondary, setHasSecondary] = useState(false);
  const [secondary, setSecondary] = useState<PersonFields>(blankPerson);
  const [children, setChildren] = useState<PersonFields[]>([]);
  const [notes, setNotes] = useState("");
  // Serialized form as last loaded/saved; isDirty compares it to current state.
  const [savedForm, setSavedForm] = useState<string | null>(null);

  // A loaded prefill without a second guardian leaves the second-guardian fields as they are.
  const reset = useCallback((prefill: IntakePrefill) => {
    const next = formFromPrefill(prefill);
    setAddress(next.address);
    setEmName(next.emName);
    setEmPhone(next.emPhone);
    setEmEmail(next.emEmail);
    setNotes(next.notes);
    setPrimary(next.primary);
    if (next.hasSecondary) {
      setHasSecondary(true);
      setSecondary(next.secondary);
    }
    setChildren(next.children);
    setSavedForm(serializeMembershipForm(next));
  }, []);

  const values: FormValues = { address, emName, emPhone, emEmail, primary, hasSecondary, secondary, children, notes };
  // Dirty once the user edits past the loaded snapshot. Re-hydrate after a
  // save/submit re-snapshots, so this flips back to false then.
  const isDirty = savedForm !== null && serializeMembershipForm(values) !== savedForm;

  return {
    values, isDirty, reset,
    setAddress, setEmName, setEmPhone, setEmEmail, setPrimary, setHasSecondary, setSecondary, setChildren, setNotes,
  };
}

export type MembershipForm = ReturnType<typeof useMembershipForm>;
