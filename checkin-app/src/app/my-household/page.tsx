"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { errorMessage, LoadError, showError, showSuccess } from '@checkin/component-ui';
import { useRequireRole } from '@/hooks/useRequireRole';
import { useSeedForm } from '@/hooks/useSeedForm';
import { api, useLoad } from '@/lib/api';
import { Alert, Badge, Button, Card, Checkbox, Group, Paper, SimpleGrid, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { AlertBanner, type AlertTone } from '@/components/admin/AlertBanner';
import { PageContainer } from '@/components/ui/PageContainer';
import EmergencyContactNotice from '@/components/ui/EmergencyContactNotice';
import { calculateAge, formatDateOnly, isYouth } from '@/lib/time';
import type { BgStatus } from '@/lib/membership/bgStatus';
import { isMembershipLapsed } from '@/lib/membership/lapsed';
import TrustedAdultPanel from '@/components/TrustedAdultPanel';
import TodoCard from '@/components/TodoCard';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { isOrgAccount } from '@/lib/orgAccount';
import { pickAddress, validateAddress, type StructuredAddress, type AddressField } from '@/lib/address';
import { isValidPhone, formatPhone, PHONE_ERROR } from '@/lib/phone';
import { isValidEmail } from '@/lib/emergencyContacts/identity';
import { useUnsavedGuard, shallowEqual } from '@/components/UnsavedChangesProvider';
import { lockedEmailHelp } from '@/lib/person/signInEmail';
import { AGE_LEAD_ONLY_REFUSAL, mayDeclareAges, UNDER_18_DECLARATION_REFUSAL } from '@/lib/person/adultDob';

import { PageLoader } from "@/components/ui/PageLoader";
const blankAddress: StructuredAddress = { line1: "", line2: "", city: "", state: "", postalCode: "" };

const EMAIL_ERROR = "Enter a valid email address.";
const DOB_ERROR = "Date of birth is required for anyone under 25.";

// Shared client validation for the member add/edit forms. Returns red-ring +
// subtext errors keyed by field; empty object means valid.
function validateHouseholdMemberFields(f: { name: string; email: string; dob: string; over25: boolean; phone?: string }) {
  const e: { name?: string; email?: string; dob?: string; phone?: string } = {};
  if (!f.name.trim()) e.name = "Name is required.";
  if (f.email && !isValidEmail(f.email)) e.email = EMAIL_ERROR;
  if (!f.over25 && !f.dob) e.dob = DOB_ERROR;
  if (f.phone && !isValidPhone(f.phone)) e.phone = PHONE_ERROR;
  return e;
}

// Upper-right age chip for a member card. A DoB drives an exact age; absent a
// DoB we trust the 25+ declaration, else the age is unknown and flagged red.
function ageBadge(p: HouseholdMember): { label: string; color: string; variant: string } {
  if (p.dateOfBirth) {
    const age = calculateAge(p.dateOfBirth);
    return age < 18 ? { label: `Age (${age})`, color: 'blue', variant: 'light' } : { label: 'Adult', color: 'gray', variant: 'light' };
  }
  if (p.isDeclaredAdult) return { label: 'Adult', color: 'gray', variant: 'light' };
  return { label: 'Age Unavailable', color: 'red', variant: 'filled' };
}

// The background-check status the route sends only to the person and their household lead.
const BG_STATUS_BADGE: Record<BgStatus, { label: string; color: string }> = {
  VALID: { label: 'Background check: Valid', color: 'green' },
  EXPIRES_BEFORE_NEXT_YEAR: { label: 'Background check: Expires before upcoming year', color: 'yellow' },
  EXPIRED: { label: 'Background check: Expired', color: 'red' },
};

type HouseholdMember = { id: number; name?: string; nickname?: string | null; email?: string; dateOfBirth?: string; phone?: string; isDeclaredAdult?: boolean; allergies?: string | null; isHouseholdLead?: boolean; emailLocked?: boolean; bgStatus?: { personId: number; status?: BgStatus } };
type EmergencyContact = { id: number; name: string; phone: string; email?: string | null; relationship?: string | null; priority: number; invalid: boolean };
type HouseholdData = {
  id?: number;
  name?: string;
  householdMembers?: HouseholdMember[];
  orgMembership?: { status?: string; memberSince?: string; isVolunteerFamily?: boolean; notRenewingYear?: number | null } | null;
} & Partial<StructuredAddress> | null;
type HouseholdAnswer = { household: HouseholdData; boardReplyTo?: string | null; validUntil?: string | null };

type MemberAnswer = { message?: string; warning?: { message: string } | null; leadRejection?: string } | null;

const blankContactForm = { id: null as number | null, name: "", phone: "", email: "", relationship: "" };

export default function HouseholdPage() {
  const { user: sessionUser, loading: authLoading, ready } = useRequireRole([]);
  const router = useRouter();

  const { data: householdAnswer, error: householdError, reload: fetchHousehold } = useLoad<HouseholdAnswer>(ready ? '/api/household' : null);
  const household = householdAnswer?.household ?? null;
  const boardReplyTo = householdAnswer?.boardReplyTo ?? null;
  const validUntil = householdAnswer?.validUntil ?? null;
  // Open renewal for this household (lead-only, from /api/membership/renewal-status).
  // Drives the "Renew now" copy for a still-ACTIVE member whose renewal has opened.
  const { data: renewalAnswer, error: renewalError, reload: reloadRenewal } = useLoad<{ renewalDue?: boolean }>(ready ? '/api/membership/renewal-status' : null);
  const renewalDue = !!renewalAnswer?.renewalDue;
  const [message, setMessage] = useState<{ text: string; tone: AlertTone } | null>(null);
  // A warning a save leaves to read stays in the page banner.
  const warn = (text: string) => setMessage({ text, tone: "warning" });
  const [addingHouseholdMember, setAddingHouseholdMember] = useState(false);
  const [savingHouseholdMember, setSavingHouseholdMember] = useState(false);

  const [householdMemberForm, setHouseholdMemberForm] = useState({ name: "", email: "", dob: "", phone: "", over25: false, allergies: "" });
  const [householdMemberErrors, setHouseholdMemberErrors] = useState<{ name?: string; email?: string; dob?: string; phone?: string }>({});

  const [editingHouseholdMemberId, setEditingHouseholdMemberId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: "", nickname: "", email: "", dob: "", phone: "", isLead: false, over25: false, allergies: "" });
  // Errors for the inline edit form. phone shown only after a Save attempt, so
  // the red ring never appears mid-typing.
  const [editErrors, setEditErrors] = useState<{ name?: string; email?: string; dob?: string; phone?: string }>({});

  const [address, setAddress] = useState<StructuredAddress>(blankAddress);
  // Snapshot of the address as last loaded/saved; isDirty compares it to current
  // state to drive the unsaved-changes guard.
  const [initialAddress, setInitialAddress] = useState<StructuredAddress>(blankAddress);
  const [addressErrors, setAddressErrors] = useState<Partial<Record<AddressField, string>>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  // Transient "Updated" confirmation shown in the Address card header for 5s.

  const [contactForm, setContactForm] = useState(blankContactForm);
  const [showContactForm, setShowContactForm] = useState(false);
  const [savingContact, setSavingContact] = useState(false);
  // Per-field client validation (red ring + subtext), checked on Add/Save click
  // so phone/email/name errors never flash while the user is still typing.
  const [contactErrors, setContactErrors] = useState<{ name?: string; phone?: string; email?: string }>({});

  // ponytail: guard ONLY the deferred Address card (committed by the "Update
  // Address" button). The member add/edit forms, emergency-contact form, and the
  // receipts toggle all submit instantly — intentionally excluded so they never
  // raise a spurious unsaved-changes prompt.
  const isDirty = !shallowEqual({ ...initialAddress }, { ...address });
  useUnsavedGuard(isDirty);

  useSeedForm(householdAnswer, isDirty, (answer) => {
    const a = pickAddress(answer.household);
    const loaded = { line1: a.line1 ?? "", line2: a.line2 ?? "", city: a.city ?? "", state: a.state ?? "", postalCode: a.postalCode ?? "" };
    setAddress(loaded);
    setInitialAddress(loaded);
  });

  const userId = (sessionUser as { id: number } | undefined)?.id;
  const viewerIsLead = household?.householdMembers?.find((m) => m.id === userId)?.isHouseholdLead ?? false;
  const agesLocked = userId !== undefined
    && !mayDeclareAges(userId, (household?.householdMembers ?? []).filter((m) => m.isHouseholdLead).map((m) => m.id));
  // The contacts card, and the API behind it, are the household lead's.
  const { data: contactsAnswer, error: contactsError, reload: fetchContacts } = useLoad<{ contacts?: EmergencyContact[] }>(
    viewerIsLead ? '/api/household/emergency-contacts' : null,
  );
  const contacts = contactsAnswer?.contacts ?? [];

  const handleSaveSettings = async () => {
    const errors = validateAddress(address);
    setAddressErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setSavingSettings(true);
    try {
      await api('/api/household/settings', { method: 'PATCH', body: JSON.stringify(address) });
      showSuccess("Settings updated successfully!");
      setInitialAddress(address);
      notifyNavRefresh();
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSaveContact = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: { name?: string; phone?: string; email?: string } = {};
    if (!contactForm.name.trim()) errs.name = "Name is required.";
    if (!isValidPhone(contactForm.phone)) errs.phone = PHONE_ERROR;
    if (contactForm.email && !isValidEmail(contactForm.email)) errs.email = EMAIL_ERROR;
    setContactErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setSavingContact(true);
    try {
      const editing = contactForm.id !== null;
      const url = editing ? `/api/household/emergency-contacts/${contactForm.id}` : '/api/household/emergency-contacts';
      await api(url, {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify({ name: contactForm.name, phone: contactForm.phone, email: contactForm.email, relationship: contactForm.relationship }),
      });
      showSuccess(editing ? "Emergency contact updated." : "Emergency contact added.");
      setContactForm(blankContactForm);
      setShowContactForm(false);
      notifyNavRefresh();
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSavingContact(false);
    }
  };

  const handleDeleteContact = async (id: number) => {
    try {
      await api(`/api/household/emergency-contacts/${id}`, { method: 'DELETE' });
      showSuccess("Emergency contact removed.");
      notifyNavRefresh();
    } catch (e) {
      showError(errorMessage(e));
    }
  };

  const startAddContact = () => {
    setContactErrors({});
    setContactForm(blankContactForm);
    setShowContactForm(true);
  };
  // Direction-B: a member change collided with an emergency contact. Surface the
  // warning and drop the lead straight into the add-contact form.
  const applyContactWarning = (warning?: { message: string } | null) => {
    if (!warning) return false;
    warn(`⚠️ ${warning.message}`);
    startAddContact();
    return true;
  };
  const startEditContact = (c: EmergencyContact) => {
    setContactErrors({});
    setContactForm({ id: c.id, name: c.name, phone: c.phone, email: c.email || "", relationship: c.relationship || "" });
    setShowContactForm(true);
  };

  const handleAddHouseholdMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingHouseholdMember) return;
    setMessage(null);
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
      if (!applyContactWarning(data?.warning)) showSuccess(data?.message || "Household member added successfully!");
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSavingHouseholdMember(false);
    }
  };

  const handleEditHouseholdMember = async (e: React.FormEvent, participantId: number, emailLocked: boolean) => {
    e.preventDefault();
    setMessage(null);
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
      if (!applyContactWarning(data?.warning)) {
        if (data?.leadRejection) warn(`Household member updated, but not added as a lead — ${data.leadRejection}`);
        else showSuccess(data?.message || "Household member updated successfully!");
      }
    } catch (e) {
      showError(errorMessage(e));
    }
  };

  const handleMakeLead = async (participantId: number) => {
    setMessage(null);
    try {
      await api('/api/household/lead', { method: 'POST', body: JSON.stringify({ participantId }) });
      showSuccess("Household member promoted to lead successfully!");
    } catch (e) {
      showError(errorMessage(e));
    }
  };

  if ((householdAnswer === null && !householdError) || authLoading) {
    return <PageLoader />;
  }

  if (!ready) return null;

  // Staff (@innovationtreehouse.org) accounts aren't real member families; the add-member
  // control is hidden for them (server also enforces this — see /api/household PATCH).
  const isStaffAccount = isOrgAccount(sessionUser as { hd?: string | null; email?: string | null });
  const isLead = (pid: number) => household?.householdMembers?.find((m) => m.id === pid)?.isHouseholdLead ?? false;

  const sortedHouseholdMembers = (household?.householdMembers || []).slice().sort((a, b) => {
    const isLeadA = isLead(a.id) ? 1 : 0;
    const isLeadB = isLead(b.id) ? 1 : 0;
    if (isLeadA !== isLeadB) return isLeadB - isLeadA;
    if (a.dateOfBirth && b.dateOfBirth) return new Date(a.dateOfBirth).getTime() - new Date(b.dateOfBirth).getTime();
    if (a.dateOfBirth) return -1;
    if (b.dateOfBirth) return 1;
    return (a.name || "").localeCompare(b.name || "");
  });

  return (
    <PageContainer>
      <Stack>
        <TodoCard />
        <Card withBorder radius="md" padding="lg">
          <Title order={1} mb="md">{household?.name || 'My Household'}</Title>

          {renewalError && <LoadError what="your renewal status" message={renewalError} onRetry={reloadRenewal} />}

          {household && (
            // An existing member — still ACTIVE with an open renewal, or already
            // REVOKED/lapsed — gets the "Renew now" nudge; a household that never
            // joined gets the join prompt; an ACTIVE member with nothing due gets
            // the plain member badge.
            (renewalDue || household.orgMembership?.status === 'REVOKED') ? (
              <Alert color="blue" mb="lg">
                <Group justify="space-between" align="center" wrap="wrap">
                  <Text c="dimmed">Renew your membership now!</Text>
                  {viewerIsLead && <Button size="xs" fz={15} onClick={() => router.push('/membership')}>Renew!</Button>}
                </Group>
              </Alert>
            ) : household.orgMembership?.status === 'ACTIVE' ? (
              <Alert mb="lg">
                <Group gap="xs" wrap="wrap">
                  {/* memberSince is a calendar date at UTC midnight — getUTCFullYear, or a Jan 1 start reads as the prior year. */}
                  <Text fw={600}>✓ Member{household.orgMembership.memberSince ? ` since ${new Date(household.orgMembership.memberSince).getUTCFullYear()}` : ''}</Text>
                  {validUntil && (
                    <Text c={isMembershipLapsed(validUntil) ? 'red' : 'dimmed'} fw={isMembershipLapsed(validUntil) ? 700 : undefined}>
                      Valid through {formatDateOnly(validUntil, { year: 'numeric', month: 'short', day: 'numeric' })}{isMembershipLapsed(validUntil) ? ' (lapsed)' : ''}
                    </Text>
                  )}
                  {household.orgMembership.isVolunteerFamily && <Badge variant="light">Volunteer-only family</Badge>}
                </Group>
              </Alert>
            ) : (
              <Alert color="blue" mb="lg">
                <Group justify="space-between" align="center" wrap="wrap">
                  <Text c="dimmed">Your household isn&apos;t a member yet.</Text>
                  {viewerIsLead && <Button size="xs" fz={15} onClick={() => router.push('/membership')}>Join the Treehouse!</Button>}
                </Group>
              </Alert>
            )
          )}

          {viewerIsLead && household?.orgMembership?.status === 'ACTIVE' && (
            <NotRenewingControl noted={household.orgMembership.notRenewingYear != null} validUntil={validUntil} />
          )}

          <AlertBanner message={message?.text} tone={message?.tone} mb="lg" />

          {householdError && <LoadError what="your household" message={householdError} onRetry={fetchHousehold} />}

          {!household ? (
            !householdError && <Stack align="center" py="md">
              <Text c="dimmed" ta="center">
                We couldn&apos;t load your household. Please refresh to try again.
              </Text>
            </Stack>
          ) : (
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

              {(isStaffAccount || !viewerIsLead) ? null : !addingHouseholdMember ? (
                <Button variant="light" onClick={() => { setHouseholdMemberErrors({}); setAddingHouseholdMember(true); }}>+ Add Household Member</Button>
              ) : (
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
              )}
            </>
          )}
        </Card>

        {household && viewerIsLead && (
          <Card withBorder radius="md" padding="lg">
            <Group justify="space-between" align="center" mb="md">
              <Title order={3} c="blue">Household Address</Title>
            </Group>
            <Text size="sm" c="dimmed" mb="sm">The main address associated with this household.</Text>
            <Stack gap="xs">
              <TextInput label="Street Address" required value={address.line1 ?? ""} error={addressErrors.line1} onChange={(e) => { setAddress({ ...address, line1: e.currentTarget.value }); setAddressErrors({ ...addressErrors, line1: undefined }); }} placeholder="123 Main St" />
              <TextInput label="Apt / Suite (optional)" value={address.line2 ?? ""} onChange={(e) => setAddress({ ...address, line2: e.currentTarget.value })} placeholder="Apt 4B" />
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                <TextInput label="City" required value={address.city ?? ""} error={addressErrors.city} onChange={(e) => { setAddress({ ...address, city: e.currentTarget.value }); setAddressErrors({ ...addressErrors, city: undefined }); }} />
                <TextInput label="State" required maxLength={2} value={address.state ?? ""} error={addressErrors.state} onChange={(e) => { setAddress({ ...address, state: e.currentTarget.value }); setAddressErrors({ ...addressErrors, state: undefined }); }} placeholder="TX" />
                <TextInput label="ZIP" required value={address.postalCode ?? ""} error={addressErrors.postalCode} onChange={(e) => { setAddress({ ...address, postalCode: e.currentTarget.value }); setAddressErrors({ ...addressErrors, postalCode: undefined }); }} placeholder="78701" />
              </SimpleGrid>
            </Stack>
            <Button onClick={handleSaveSettings} disabled={savingSettings} loading={savingSettings} fullWidth mt="md">
              Save household details
            </Button>
          </Card>
        )}

        {household && viewerIsLead && (
          <Card withBorder radius="md" padding="lg" id="emergency-contact" style={{ scrollMarginTop: 80 }}>
                <Group justify="space-between" align="center" mb="xs">
                  <Title order={3} c="yellow">Emergency Contacts</Title>
                  {!showContactForm && <Button size="compact-xs" variant="light" onClick={startAddContact}>+ Add Contact</Button>}
                </Group>
                <Text size="sm" c="dimmed" mb="sm">
                  At least one is required.
                </Text>
                <EmergencyContactNotice mb="sm" />


                {contactsError && <LoadError what="emergency contacts" message={contactsError} onRetry={fetchContacts} />}

                {contactsAnswer !== null && contacts.length === 0 && !showContactForm && (
                  <Alert color="red" variant="light">No emergency contact on file. Add at least one.</Alert>
                )}

                <Stack gap="xs">
                  {contacts.map((c) => {
                    // Can't remove the only valid contact — a household must keep at least one.
                    const validCount = contacts.filter((x) => !x.invalid).length;
                    const isLastValid = !c.invalid && validCount <= 1;
                    return (
                    <Paper key={c.id} withBorder radius="sm" p="sm" bg={c.invalid ? 'var(--mantine-color-red-light)' : undefined}>
                      <Group justify="space-between" wrap="nowrap">
                        <div>
                          <Group gap="xs">
                            <Text fw={600}>{c.name || "Unnamed"}</Text>
                            {c.relationship && <Badge variant="light" color="gray">{c.relationship}</Badge>}
                            {c.invalid && <Badge variant="light" color="red">Invalid — is a household member</Badge>}
                          </Group>
                          <Text size="sm" c="dimmed">{formatPhone(c.phone)}{c.email ? ` • ${c.email}` : ''}</Text>
                        </div>
                        <Group gap="xs" wrap="nowrap">
                          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => startEditContact(c)}>Edit</Button>
                          <Tooltip label="Can't remove last emergency contact. Add a new one first." disabled={!isLastValid}>
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              color="red"
                              data-disabled={isLastValid || undefined}
                              onClick={(e) => {
                                if (isLastValid) {
                                  e.preventDefault();
                                  return;
                                }
                                handleDeleteContact(c.id);
                              }}
                            >Remove</Button>
                          </Tooltip>
                        </Group>
                      </Group>
                    </Paper>
                    );
                  })}
                </Stack>

                {showContactForm && (
                  <form onSubmit={handleSaveContact}>
                    <Stack gap="xs" mt="sm">
                      <SimpleGrid cols={{ base: 1, sm: 2 }}>
                        <TextInput label="Contact Name" value={contactForm.name} error={contactErrors.name} onChange={(e) => { setContactForm({ ...contactForm, name: e.currentTarget.value }); setContactErrors({ ...contactErrors, name: undefined }); }} placeholder="Full Name" />
                        <TextInput type="tel" label="Phone" value={contactForm.phone} error={contactErrors.phone} onChange={(e) => { setContactForm({ ...contactForm, phone: e.currentTarget.value }); setContactErrors({ ...contactErrors, phone: undefined }); }} placeholder="(555) 555-5555" />
                        <TextInput inputMode="email" label="Email (optional)" value={contactForm.email} error={contactErrors.email} onChange={(e) => { setContactForm({ ...contactForm, email: e.currentTarget.value }); setContactErrors({ ...contactErrors, email: undefined }); }} />
                        <TextInput label="Relationship (optional)" value={contactForm.relationship} onChange={(e) => setContactForm({ ...contactForm, relationship: e.currentTarget.value })} placeholder="Aunt, Neighbor…" />
                      </SimpleGrid>
                      <Group gap="xs">
                        <Button type="submit" size="xs" fz={15} loading={savingContact}>{contactForm.id !== null ? "Save Contact" : "Add Contact"}</Button>
                        <Button type="button" size="xs" fz={15} variant="default" onClick={() => { setShowContactForm(false); setContactForm(blankContactForm); setContactErrors({}); }}>Cancel</Button>
                      </Group>
                    </Stack>
                  </form>
                )}
          </Card>
        )}

        {household && viewerIsLead && (
          <Card withBorder radius="md" padding="lg">
            <Title order={3} c="grape" mb="sm">Trusted Adults</Title>
            <TrustedAdultPanel />
          </Card>
        )}

      </Stack>
    </PageContainer>
  );
}

/** A lead says the household won't renew, or takes it back; the membership itself is untouched. */
function NotRenewingControl({ noted, validUntil }: { noted: boolean; validUntil: string | null }) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const send = async (method: 'POST' | 'DELETE') => {
    setSaving(true);
    try {
      await api('/api/membership/not-renewing', { method });
      showSuccess(method === 'POST' ? "We've told the Board you won't be renewing." : "Your renewal reminders will resume.");
      setConfirming(false);
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (noted) {
    return (
      <Alert color="gray" mb="lg">
        <Group justify="space-between" align="center" wrap="wrap">
          <Text>You&apos;ve told the Board you won&apos;t be renewing. You can still renew at any time.</Text>
          <Button size="xs" fz={15} variant="default" loading={saving} onClick={() => send('DELETE')}>Undo</Button>
        </Group>
      </Alert>
    );
  }

  if (!confirming) {
    return (
      <Group mb="lg">
        <Button size="xs" fz={15} variant="subtle" color="gray" onClick={() => setConfirming(true)}>We won&apos;t be renewing</Button>
      </Group>
    );
  }

  const through = validUntil ? formatDateOnly(validUntil, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
  return (
    <Alert color="gray" mb="lg" title="Tell the Board you won't be renewing?">
      <Stack gap="xs">
        <Text size="sm">
          Your membership continues {through ? `through ${through}` : 'to the end of the year you have paid for'}, and
          renewal emails stop. You can change your mind and renew at any time from this page.
        </Text>
        <Group>
          <Button size="xs" fz={15} color="gray" loading={saving} onClick={() => send('POST')}>Yes, tell the Board</Button>
          <Button size="xs" fz={15} variant="default" disabled={saving} onClick={() => setConfirming(false)}>Cancel</Button>
        </Group>
      </Stack>
    </Alert>
  );
}
