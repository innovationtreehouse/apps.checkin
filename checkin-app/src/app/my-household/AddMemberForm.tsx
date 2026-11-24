"use client";

import { useState } from 'react';
import { errorMessage, showError, showSuccess } from '@checkin/component-ui';
import { Button, Card, Checkbox, Group, Modal, Stack, Text, TextInput, Title } from '@mantine/core';
import { api } from '@/lib/api';
import { secondLeadQuestionDue } from '@/lib/household/secondLead';
import { validateHouseholdMemberFields, type ContactWarning, type HouseholdMember, type MemberAnswer, type MemberFieldErrors } from './household';

export default function AddMemberForm({ members, onClearMessage, onContactWarning }: {
  members: HouseholdMember[];
  onClearMessage: () => void;
  onContactWarning: (warning: ContactWarning) => boolean;
}) {
  const [askAbout, setAskAbout] = useState<HouseholdMember | null>(null);
  const [answering, setAnswering] = useState(false);

  // Closing without an answer leaves them an adult who isn't a lead, who signs their own agreement once they take part.
  const makeSecondLead = async () => {
    if (!askAbout || answering) return;
    setAnswering(true);
    try {
      await api('/api/household/lead', { method: 'POST', body: JSON.stringify({ participantId: askAbout.id }) });
      setAskAbout(null);
      showSuccess(`${askAbout.name} is now a household lead.`);
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setAnswering(false);
    }
  };
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
      const added = data?.member;
      if (added && secondLeadQuestionDue([...members.filter((m) => m.id !== added.id), added], added.id)) setAskAbout(added);
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSavingHouseholdMember(false);
    }
  };

  const question = (
    <Modal opened={askAbout !== null} onClose={() => setAskAbout(null)} title={<Text span fw={700} fz="lg">Make {askAbout?.name} a second lead?</Text>}>
      <Stack>
        <Text size="sm">
          If {askAbout?.name} is your partner or spouse, make them a second household lead: they
          are covered by the household&apos;s membership agreement. Any other adult in the
          household signs their own agreement once they take part in a program or volunteer.
        </Text>
        <Button loading={answering} disabled={answering} onClick={makeSecondLead}>Yes, make them a second lead</Button>
        <Button variant="default" disabled={answering} onClick={() => setAskAbout(null)}>No</Button>
      </Stack>
    </Modal>
  );

  if (!addingHouseholdMember) {
    return (
      <>
        <Button variant="light" onClick={() => { setHouseholdMemberErrors({}); setAddingHouseholdMember(true); }}>+ Add Household Member</Button>
        {question}
      </>
    );
  }

  return (
    <Card withBorder radius="md" padding="lg">
      {question}
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
