"use client";

import { useState } from 'react';
import { errorMessage, showError, showSuccess } from '@checkin/component-ui';
import { Badge, Button, Card, Checkbox, Group, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { api } from '@/lib/api';
import { calculateAge, isYouth } from '@/lib/time';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { formatPhone } from '@/lib/phone';
import { lockedEmailHelp } from '@/lib/person/signInEmail';
import { AGE_LEAD_ONLY_REFUSAL, UNDER_18_DECLARATION_REFUSAL } from '@/lib/person/adultDob';
import {
  ageBadge, BG_STATUS_BADGE, validateHouseholdMemberFields,
  type ContactWarning, type HouseholdMember, type MemberAnswer, type MemberFieldErrors,
} from './household';

export default function HouseholdMembersSection({ members, userId, viewerIsLead, agesLocked, boardReplyTo, onClearMessage, onWarn, onContactWarning }: {
  members: HouseholdMember[];
  userId: number | undefined;
  viewerIsLead: boolean;
  agesLocked: boolean;
  boardReplyTo: string | null;
  onClearMessage: () => void;
  onWarn: (text: string) => void;
  onContactWarning: (warning: ContactWarning) => boolean;
}) {
  const [editingHouseholdMemberId, setEditingHouseholdMemberId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: "", nickname: "", email: "", dob: "", phone: "", isLead: false, over25: false, allergies: "" });
  // Errors for the inline edit form. phone shown only after a Save attempt, so
  // the red ring never appears mid-typing.
  const [editErrors, setEditErrors] = useState<MemberFieldErrors>({});

  const handleEditHouseholdMember = async (e: React.FormEvent, participantId: number, emailLocked: boolean) => {
    e.preventDefault();
    onClearMessage();
    const errs = validateHouseholdMemberFields(editForm);
    setEditErrors(errs);
    if (Object.keys(errs).length > 0) return;
    try {
      const data = await api<MemberAnswer>('/api/household/member', {
        method: 'PATCH',
        body: JSON.stringify({ participantId, name: editForm.name, nickname: editForm.nickname, email: emailLocked ? undefined : editForm.email, dob: editForm.over25 ? "" : editForm.dob, phone: editForm.phone, isLead: editForm.isLead, over25: editForm.over25, allergies: editForm.allergies })
      });
      setEditErrors({});
      setEditingHouseholdMemberId(null);
      notifyNavRefresh();
      // A member edit can both collide with an emergency contact (warning,
      // which also opens the add-contact flow) and be declined the lead
      // promotion (leadRejection). Surface the contact warning first since
      // it's the more urgent, then the lead caveat, else a plain success.
      if (!onContactWarning(data?.warning)) {
        if (data?.leadRejection) onWarn(`Household member updated, but not added as a lead — ${data.leadRejection}`);
        else showSuccess(data?.message || "Household member updated successfully!");
      }
    } catch (e) {
      showError(errorMessage(e));
    }
  };

  const handleMakeLead = async (participantId: number) => {
    onClearMessage();
    try {
      await api('/api/household/lead', { method: 'POST', body: JSON.stringify({ participantId }) });
      showSuccess("Household member promoted to lead successfully!");
    } catch (e) {
      showError(errorMessage(e));
    }
  };

  const isLead = (pid: number) => members.find((m) => m.id === pid)?.isHouseholdLead ?? false;

  const sortedHouseholdMembers = members.slice().sort((a, b) => {
    const isLeadA = isLead(a.id) ? 1 : 0;
    const isLeadB = isLead(b.id) ? 1 : 0;
    if (isLeadA !== isLeadB) return isLeadB - isLeadA;
    if (a.dateOfBirth && b.dateOfBirth) return new Date(a.dateOfBirth).getTime() - new Date(b.dateOfBirth).getTime();
    if (a.dateOfBirth) return -1;
    if (b.dateOfBirth) return 1;
    return (a.name || "").localeCompare(b.name || "");
  });

  return (
    <>
      <Title order={3} mb="md">Household Members</Title>
      <SimpleGrid cols={{ base: 1, sm: 2 }} mb="lg">
        {sortedHouseholdMembers.map((p) => {
          const householdMemberIsLead = isLead(p.id);
          const isAdult = (p.dateOfBirth && calculateAge(p.dateOfBirth) >= 18) || p.isDeclaredAdult;
          // A household lead needs a phone on file — flag the box so the
          // lead can see exactly which member to fix (mirrors the nav todo).
          const leadMissingPhone = householdMemberIsLead && !p.phone;
          return (
            <Card key={p.id} withBorder radius="md" padding="md" bg={leadMissingPhone ? 'var(--mantine-color-red-light)' : undefined}>
              {editingHouseholdMemberId === p.id ? (
                <form onSubmit={(e) => handleEditHouseholdMember(e, p.id, !!p.emailLocked)}>
                  <Stack gap="xs">
                    <TextInput size="xs" label="Name" description="Printed on name badges exactly as typed — please double-check the spelling." value={editForm.name} error={editErrors.name} onChange={(e) => { setEditForm({ ...editForm, name: e.currentTarget.value }); setEditErrors({ ...editErrors, name: undefined }); }} />
                    <TextInput size="xs" label="Nickname (optional)" description="Printed on the name badge in place of the first name." value={editForm.nickname} onChange={(e) => setEditForm({ ...editForm, nickname: e.currentTarget.value })} />
                    <TextInput size="xs" inputMode="email" label="Email" value={editForm.email} disabled={p.emailLocked} description={p.emailLocked ? lockedEmailHelp(boardReplyTo) : undefined} error={editErrors.email} onChange={(e) => { setEditForm({ ...editForm, email: e.currentTarget.value }); setEditErrors({ ...editErrors, email: undefined }); }} />
                    <Checkbox size="xs" label="Individual is over 25" disabled={agesLocked || isYouth(p.dateOfBirth)} description={agesLocked ? AGE_LEAD_ONLY_REFUSAL : isYouth(p.dateOfBirth) ? UNDER_18_DECLARATION_REFUSAL : undefined} checked={editForm.over25} onChange={(e) => { setEditForm({ ...editForm, over25: e.currentTarget.checked, dob: e.currentTarget.checked ? "" : editForm.dob }); setEditErrors({ ...editErrors, dob: undefined }); }} />
                    {!editForm.over25 && (
                      <TextInput size="xs" type="date" label="Date of Birth" value={editForm.dob} disabled={agesLocked} error={editErrors.dob} onChange={(e) => { setEditForm({ ...editForm, dob: e.currentTarget.value }); setEditErrors({ ...editErrors, dob: undefined }); }} />
                    )}
                    <TextInput size="xs" type="tel" label="Phone" value={editForm.phone} error={editErrors.phone} onChange={(e) => { setEditForm({ ...editForm, phone: e.currentTarget.value }); setEditErrors({ ...editErrors, phone: undefined }); }} />
                    <TextInput size="xs" label="Allergies (optional)" value={editForm.allergies} onChange={(e) => setEditForm({ ...editForm, allergies: e.currentTarget.value })} />
                    {p.id !== userId && (editForm.over25 || (editForm.dob && calculateAge(editForm.dob) >= 18)) && (
                      <Checkbox label="Household Lead" checked={editForm.isLead} onChange={(e) => setEditForm({ ...editForm, isLead: e.currentTarget.checked })} />
                    )}
                    <Group gap="xs">
                      <Button type="submit" size="xs" fz={15}>Save</Button>
                      <Button type="button" size="xs" fz={15} variant="default" onClick={() => { setEditingHouseholdMemberId(null); setEditErrors({}); }}>Cancel</Button>
                    </Group>
                  </Stack>
                </form>
              ) : (
                <>
                  <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
                    <Text fw={600} style={{ wordBreak: 'break-word' }}>{p.name || "Unnamed"}</Text>
                    {(() => { const b = ageBadge(p); return <Badge color={b.color} variant={b.variant} style={{ flexShrink: 0 }}>{b.label}</Badge>; })()}
                  </Group>
                  {p.email && <Text size="sm" c="dimmed" style={{ wordBreak: 'break-word' }}>{p.email}</Text>}
                  {p.phone && <Text size="sm" c="dimmed" style={{ wordBreak: 'break-word' }}>{formatPhone(p.phone)}</Text>}
                  {p.allergies && <Text size="sm" c="dimmed" style={{ wordBreak: 'break-word' }}>Allergies: {p.allergies}</Text>}
                  {leadMissingPhone && <Badge color="red" variant="filled" mt="xs">Add a phone number</Badge>}
                  {p.bgStatus?.status && <Badge color={BG_STATUS_BADGE[p.bgStatus.status].color} variant="light" mt="xs" style={{ whiteSpace: 'normal', height: 'auto' }}>{BG_STATUS_BADGE[p.bgStatus.status].label}</Badge>}
                  <Group gap="xs" mt="sm">
                    {householdMemberIsLead && <Badge color="grape" variant="light">Household Lead</Badge>}
                    {!householdMemberIsLead && isAdult && viewerIsLead && (
                      <Button size="compact-xs" variant="light" onClick={() => handleMakeLead(p.id)}>Make Lead</Button>
                    )}
                    {(p.id === userId ? !isYouth(p.dateOfBirth) : viewerIsLead) && (
                      <Button size="compact-xs" variant="subtle" color="gray" onClick={() => {
                        setEditingHouseholdMemberId(p.id);
                        setEditErrors({});
                        setEditForm({ name: p.name || "", nickname: p.nickname || "", email: p.email || "", dob: p.dateOfBirth ? new Date(p.dateOfBirth).toISOString().split('T')[0] : "", phone: p.phone || "", isLead: householdMemberIsLead, over25: !p.dateOfBirth && !!p.isDeclaredAdult, allergies: p.allergies || "" });
                      }}>Edit</Button>
                    )}
                  </Group>
                </>
              )}
            </Card>
          );
        })}
      </SimpleGrid>
    </>
  );
}
