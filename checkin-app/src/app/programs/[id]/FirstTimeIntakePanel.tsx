"use client";

import { useState } from "react";
import { Button, Center, Checkbox, Loader, Stack, Text, TextInput, Title } from "@mantine/core";
import { errorMessage, HttpError, LoadError, showError, showWarning } from "@checkin/component-ui";
import { api, useLoad } from "@/lib/api";
import { useSeedForm } from "@/hooks/useSeedForm";
import { mapServerFields, type IntakePrefill } from "@/app/membership/membershipForm";
import { pickAddress, type StructuredAddress } from "@/lib/address";
import { isValidPhone, PHONE_ERROR } from "@/lib/phone";
import { INTAKE_PROFILES, missingRequiredFields, type IntakeSubmitContext } from "@/lib/intake/profiles";
import AddressForm from "@/components/membership/AddressForm";
import EmergencyContactForm from "@/components/membership/EmergencyContactForm";
import ChildrenListForm from "@/components/membership/ChildrenListForm";

/**
 * First-time household setup for auth-first program registration. Shown
 * inline on /programs/[id] when a freshly-signed-in user has no enrollable
 * participant and/or no emergency contact. Collects the minimum the enroll step
 * needs, then hands control back so the existing member-select + Shopify flow
 * can run.
 *
 * Reuses the membership intake form components and the `program-first-time`
 * field profile (which drives shown/required fields) — no duplicated field list.
 * Saves via the process-free /api/household/intake route (NOT a membership
 * application). Participant email/phone is intentionally omitted here.
 */

const blankAddress: StructuredAddress = { line1: "", line2: "", city: "", state: "", postalCode: "" };

interface ChildForm {
  id?: number;
  name: string;
  email: string;
  dob: string;
  allergies: string;
}

export default function FirstTimeIntakePanel({ ageGated, onSaved }: { ageGated: boolean; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [address, setAddress] = useState<StructuredAddress>(blankAddress);
  const [emName, setEmName] = useState("");
  const [emPhone, setEmPhone] = useState("");
  const [emEmail, setEmEmail] = useState("");
  const [primaryName, setPrimaryName] = useState("");
  const [primaryDob, setPrimaryDob] = useState("");
  const [primaryOver25, setPrimaryOver25] = useState(false);
  const [primaryAllergies, setPrimaryAllergies] = useState("");
  const [children, setChildren] = useState<ChildForm[]>([]);

  const clearErr = (key: string) =>
    setFieldErrors((fe) => (fe[key] ? Object.fromEntries(Object.entries(fe).filter(([k]) => k !== key)) : fe));

  // Prefill from the caller's household so a returning user only sees the gaps.
  // Seeded once: the only save leaves the panel, so a later answer never replaces typing.
  const prefill = useLoad<{ prefill?: IntakePrefill }>("/api/household/intake");
  const [seeded, setSeeded] = useState(false);
  useSeedForm(prefill.data, seeded, (s) => {
    setSeeded(true);
    const h = s.prefill?.household;
    const a = pickAddress(h);
    setAddress({ line1: a.line1 ?? "", line2: a.line2 ?? "", city: a.city ?? "", state: a.state ?? "", postalCode: a.postalCode ?? "" });
    setEmName(h?.emergencyContactName ?? "");
    setEmPhone(h?.emergencyContactPhone ?? "");
    setEmEmail(h?.emergencyContactEmail ?? "");
    setPrimaryName(s.prefill?.primaryParent?.name ?? "");
    setPrimaryDob(s.prefill?.primaryParent?.dob ?? "");
    setPrimaryOver25(!!s.prefill?.primaryParent?.over25);
    setPrimaryAllergies(s.prefill?.primaryParent?.allergies ?? "");
    setChildren((s.prefill?.children ?? []).map((c) => ({ id: c.id, name: c.name ?? "", email: "", dob: c.dob ?? "", allergies: c.allergies ?? "" })));
  });

  const addChild = () => setChildren((c) => [...c, { name: "", email: "", dob: "", allergies: "" }]);
  const updateChild = (i: number, field: keyof ChildForm, value: string) =>
    setChildren((c) => c.map((child, idx) => (idx === i ? { ...child, [field]: value } : child)));
  const removeChild = (i: number) => setChildren((c) => c.filter((_, idx) => idx !== i));

  const namedChildren = children.filter((c) => c.name.trim());

  // Required-ness comes from the program-first-time profile (single source of
  // truth), mapped onto the form's inputs for red-box feedback.
  // The primary adult can be the enrollee themselves (single-person household):
  // an entered DOB or the over-25 declaration counts as their age being set.
  const primarySelfEnrolling = !!primaryDob || primaryOver25;

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    const ctx: IntakeSubmitContext = {
      emergencyContacts: emName.trim() && emPhone.trim() ? [{ conflictParticipantId: null, name: emName, phone: emPhone }] : [],
      primaryName,
      // Self is an age-gated enrollee only when giving an exact DOB; over-25 is a
      // declared-adult flag (no DOB expected), same as the my-household form.
      participants: [
        ...namedChildren.map((c) => ({ dob: c.dob || null, ageGated })),
        ...(primaryDob ? [{ dob: primaryDob, ageGated }] : []),
      ],
    };
    for (const m of missingRequiredFields(INTAKE_PROFILES["program-first-time"], ctx)) {
      if (m.field === "primaryName") errs.primaryName = "Your name is required.";
      else if (m.field === "emergencyContact") {
        errs.emName = "Add an emergency contact who isn't in your household.";
        errs.emPhone = "Add an emergency contact who isn't in your household.";
      } else if (m.field === "participantDob") errs.childDob = "Enter each participant's date of birth.";
    }
    // Format check mirrors the server guard so a filled-but-invalid number gets
    // inline feedback instead of a 500 from the intake save.
    if (emPhone.trim() && !isValidPhone(emPhone)) errs.emPhone = PHONE_ERROR;
    // An age-gated program needs someone to actually enroll — a household member,
    // or the adult themselves once they've set their own age.
    if (ageGated && namedChildren.length === 0 && !primarySelfEnrolling)
      errs.child = "Add the household member you want to enroll, or set your date of birth below to enroll yourself.";
    return errs;
  };

  const save = async () => {
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length) {
      showError("Please complete the highlighted fields.");
      return;
    }
    setSaving(true);
    try {
      const { rejections } = await api<{ rejections?: { message: string }[] }>("/api/household/intake", {
        method: "POST",
        body: JSON.stringify({
          household: { ...address, emergencyContactName: emName, emergencyContactPhone: emPhone, emergencyContactEmail: emEmail },
          // Adult's age is captured so a single-person household can enroll itself.
          // over25 wins when checked (declared adult, DOB cleared), matching my-household.
          primaryParent: { name: primaryName, dob: primaryOver25 ? null : primaryDob || null, over25: primaryOver25, allergies: primaryAllergies || null },
          children: namedChildren.map((c) => ({ id: c.id, name: c.name, dob: c.dob || null, allergies: c.allergies || null })),
        }),
      });
      // A part the save could not apply stays for the person to read.
      for (const r of rejections ?? []) showWarning(r.message);
      onSaved();
    } catch (e) {
      if (e instanceof HttpError) setFieldErrors(mapServerFields([...e.fields]));
      showError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (prefill.error) return <LoadError what="your household details" message={prefill.error} onRetry={prefill.reload} />;
  if (!prefill.data) return <Center py="md"><Loader size="sm" /></Center>;

  return (
    <Stack gap="lg">
      <div>
        <Title order={4}>Finish setting up your household</Title>
        <Text c="dimmed" size="sm">We just need a few details before you can enroll.</Text>
      </div>

      <section>
        <Title order={5} mb="sm">Enrolling someone else in your household? Enter their info now</Title>
        <ChildrenListForm
          items={children}
          onAdd={addChild}
          onUpdate={updateChild}
          onRemove={removeChild}
          hideEmail
          titleText="Household members"
          addText="+ Add household member"
          emptyText="No other household members added yet."
          itemLabel="Household member"
        />
        {fieldErrors.child && <Text c="red" size="sm" mt="xs">{fieldErrors.child}</Text>}
        {fieldErrors.childDob && <Text c="red" size="sm" mt="xs">{fieldErrors.childDob}</Text>}
      </section>

      <section>
        <Title order={5} mb="sm">About you</Title>
        <TextInput
          label="Your full name"
          value={primaryName}
          error={fieldErrors.primaryName}
          onChange={(e) => { setPrimaryName(e.currentTarget.value); clearErr("primaryName"); }}
        />
        <Checkbox
          mt="sm"
          label="I am over 25"
          checked={primaryOver25}
          onChange={(e) => { setPrimaryOver25(e.currentTarget.checked); if (e.currentTarget.checked) setPrimaryDob(""); clearErr("child"); }}
        />
        {!primaryOver25 && (
          <TextInput
            type="date"
            mt="sm"
            label="Your date of birth"
            description="Fill this in if you're the one enrolling."
            value={primaryDob}
            onChange={(e) => { setPrimaryDob(e.currentTarget.value); clearErr("child"); }}
          />
        )}
        <TextInput mt="sm" label="Allergies (optional)" value={primaryAllergies} onChange={(e) => setPrimaryAllergies(e.currentTarget.value)} />
      </section>

      <section>
        <Title order={5} mb="sm">Emergency contact</Title>
        <EmergencyContactForm
          emName={emName} setEmName={setEmName}
          emPhone={emPhone} setEmPhone={setEmPhone}
          emEmail={emEmail} setEmEmail={setEmEmail}
          errors={fieldErrors}
          clearErr={clearErr}
        />
      </section>

      <section>
        <Title order={5} mb="sm">Home address (optional)</Title>
        <AddressForm address={address} onChange={setAddress} onErrorClear={() => {}} required={false} />
      </section>


      <Button size="md" onClick={save} loading={saving} disabled={saving}>Save &amp; continue to enroll</Button>
    </Stack>
  );
}
