"use client";

import { useState } from 'react';
import { errorMessage, showError, showSuccess } from '@checkin/component-ui';
import { Button, Card, Checkbox, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { api } from '@/lib/api';
import { validateHouseholdMemberFields, type ContactWarning, type MemberAnswer, type MemberFieldErrors } from './household';

export default function AddMemberForm({ onClearMessage, onContactWarning }: {
  onClearMessage: () => void;
  onContactWarning: (warning: ContactWarning) => boolean;
}) {
  const [addingHouseholdMember, setAddingHouseholdMember] = useState(false);
  const [savingHouseholdMember, setSavingHouseholdMember] = useState(false);
  const [householdMemberForm, setHouseholdMemberForm] = useState({ name: "", email: "", dob: "", phone: "", over25: false, allergies: "" });
  const [householdMemberErrors, setHouseholdMemberErrors] = useState<MemberFieldErrors>({});

  const handleAddHouseholdMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingHouseholdMember) return;
    onClearMessage();
    const errs = validateHouseholdMemberFields(householdMemberForm);
    setHouseholdMemberErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setSavingHouseholdMember(true);
    try {
      const data = await api<MemberAnswer>('/api/household', {
        method: 'PATCH',
        body: JSON.stringify({ memberName: householdMemberForm.name, memberEmail: householdMemberForm.email, memberDob: householdMemberForm.over25 ? "" : householdMemberForm.dob, memberPhone: householdMemberForm.phone, memberOver25: householdMemberForm.over25, memberAllergies: householdMemberForm.allergies })
      });
      setHouseholdMemberForm({ name: "", email: "", dob: "", phone: "", over25: false, allergies: "" });
      setHouseholdMemberErrors({});
      setAddingHouseholdMember(false);
      if (!onContactWarning(data?.warning)) showSuccess(data?.message || "Household member added successfully!");
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSavingHouseholdMember(false);
    }
  };

  if (!addingHouseholdMember) {
    return <Button variant="light" onClick={() => { setHouseholdMemberErrors({}); setAddingHouseholdMember(true); }}>+ Add Household Member</Button>;
  }

  return (
    <Card withBorder radius="md" padding="lg">
      <form onSubmit={handleAddHouseholdMember}>
        <Title order={4}>Household Member Registration</Title>
        <Text c="dimmed" size="sm" mb="lg">
          If you enter an email address, their account will be correctly linked to this
          household the first time they log in via Google. Leave the email blank if they
          are a student dependent who will not sign in themselves.
        </Text>
        <Stack>
          <TextInput label="Full Name" description="Printed on name badges exactly as typed — please double-check the spelling." value={householdMemberForm.name} error={householdMemberErrors.name} onChange={(e) => { setHouseholdMemberForm({ ...householdMemberForm, name: e.currentTarget.value }); setHouseholdMemberErrors({ ...householdMemberErrors, name: undefined }); }} />
          <TextInput inputMode="email" label="Email (Optional)" value={householdMemberForm.email} error={householdMemberErrors.email} onChange={(e) => { setHouseholdMemberForm({ ...householdMemberForm, email: e.currentTarget.value }); setHouseholdMemberErrors({ ...householdMemberErrors, email: undefined }); }} placeholder="spouse@example.com" />
          <Checkbox label="Individual is over 25" checked={householdMemberForm.over25} onChange={(e) => { setHouseholdMemberForm({ ...householdMemberForm, over25: e.currentTarget.checked, dob: e.currentTarget.checked ? "" : householdMemberForm.dob }); setHouseholdMemberErrors({ ...householdMemberErrors, dob: undefined }); }} />
          {!householdMemberForm.over25 && (
            <TextInput type="date" label="Date of Birth" value={householdMemberForm.dob} error={householdMemberErrors.dob} onChange={(e) => { setHouseholdMemberForm({ ...householdMemberForm, dob: e.currentTarget.value }); setHouseholdMemberErrors({ ...householdMemberErrors, dob: undefined }); }} />
          )}
          <TextInput type="tel" label="Phone (optional)" value={householdMemberForm.phone} error={householdMemberErrors.phone} onChange={(e) => { setHouseholdMemberForm({ ...householdMemberForm, phone: e.currentTarget.value }); setHouseholdMemberErrors({ ...householdMemberErrors, phone: undefined }); }} />
          <TextInput label="Allergies (optional)" value={householdMemberForm.allergies} onChange={(e) => setHouseholdMemberForm({ ...householdMemberForm, allergies: e.currentTarget.value })} />
          <Group grow>
            <Button type="submit" disabled={savingHouseholdMember} loading={savingHouseholdMember}>Save / Invite</Button>
            <Button type="button" variant="default" onClick={() => { setAddingHouseholdMember(false); setHouseholdMemberErrors({}); }}>Cancel</Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}
