"use client";

import { Alert, Button, Card, Checkbox, Group, SimpleGrid, Stack, Textarea, TextInput, Title } from "@mantine/core";
import type { AlertTone } from "@/components/admin/AlertBanner";
import AddressForm from "@/components/membership/AddressForm";
import EmergencyContactForm from "@/components/membership/EmergencyContactForm";
import ChildrenListForm from "@/components/membership/ChildrenListForm";
import { blankPerson, type MembershipForm, type PersonFields } from "./membershipForm";

type ChildField = Exclude<keyof PersonFields, "over25">;

/** The INTAKE step: household, guardians, children and notes, with save and submit. */
export default function IntakePanel({ form, fieldErrors, clearErr, message, saving, onSave, onSubmit }: {
  form: MembershipForm;
  fieldErrors: Record<string, string>;
  clearErr: (key: string) => void;
  message: { text: string; tone: AlertTone } | undefined;
  saving: boolean;
  onSave: () => void;
  onSubmit: () => void;
}) {
  const { values: { address, emName, emPhone, emEmail, primary, hasSecondary, secondary, children, notes } } = form;
  const { setAddress, setEmName, setEmPhone, setEmEmail, setPrimary, setHasSecondary, setSecondary, setChildren, setNotes } = form;

  const addChild = () => setChildren((c) => [...c, { ...blankPerson }]);
  const updateChild = (i: number, field: ChildField, value: string) =>
    setChildren((c) => c.map((child, idx) => (idx === i ? { ...child, [field]: value } : child)));
  const removeChild = (i: number) => setChildren((c) => c.filter((_, idx) => idx !== i));

  return (
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
          <TextInput label="Full name" description="Printed on name badges exactly as typed — please double-check the spelling." value={primary.name} error={fieldErrors.primaryName} onChange={(e) => { const name = e.currentTarget.value; setPrimary((p) => ({ ...p, name })); clearErr("primaryName"); }} />
          <Checkbox
            mt="md"
            label="Individual is over 25"
            checked={primary.over25}
            onChange={(e) => { const over25 = e.currentTarget.checked; setPrimary((p) => ({ ...p, over25, dob: over25 ? "" : p.dob })); }}
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }} mt="md">
            {!primary.over25 && (
              <TextInput type="date" label="Date of birth" value={primary.dob} onChange={(e) => { const dob = e.currentTarget.value; setPrimary((p) => ({ ...p, dob })); }} />
            )}
            <TextInput label="Allergies (optional)" value={primary.allergies} onChange={(e) => { const allergies = e.currentTarget.value; setPrimary((p) => ({ ...p, allergies })); }} />
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
              <TextInput label="Full name" description="Printed on name badges exactly as typed — please double-check the spelling." value={secondary.name} onChange={(e) => { const name = e.currentTarget.value; setSecondary((p) => ({ ...p, name })); }} />
              <Checkbox
                label="Individual is over 25"
                checked={secondary.over25}
                onChange={(e) => { const over25 = e.currentTarget.checked; setSecondary((p) => ({ ...p, over25, dob: over25 ? "" : p.dob })); }}
              />
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput type="email" label="Email (optional)" value={secondary.email} onChange={(e) => { const email = e.currentTarget.value; setSecondary((p) => ({ ...p, email })); }} />
                {!secondary.over25 && (
                  <TextInput type="date" label="Date of birth" value={secondary.dob} onChange={(e) => { const dob = e.currentTarget.value; setSecondary((p) => ({ ...p, dob })); }} />
                )}
              </SimpleGrid>
              <TextInput label="Allergies (optional)" value={secondary.allergies} onChange={(e) => { const allergies = e.currentTarget.value; setSecondary((p) => ({ ...p, allergies })); }} />
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
          <Button variant="default" disabled={saving} loading={saving} onClick={onSave}>Save progress</Button>
          <Button disabled={saving} loading={saving} onClick={onSubmit}>Submit &amp; continue</Button>
        </Group>
      </Stack>
    </Card>
  );
}
