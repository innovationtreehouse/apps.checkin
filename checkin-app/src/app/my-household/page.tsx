"use client";

import { useState } from 'react';
import { errorMessage, LoadError, showError, showSuccess } from '@checkin/component-ui';
import { useRequireRole } from '@/hooks/useRequireRole';
import { useSeedForm } from '@/hooks/useSeedForm';
import { api, useLoad } from '@/lib/api';
import { Card, Stack, Text, Title } from '@mantine/core';
import { AlertBanner, type AlertTone } from '@/components/admin/AlertBanner';
import { PageContainer } from '@/components/ui/PageContainer';
import TrustedAdultPanel from '@/components/TrustedAdultPanel';
import TodoCard from '@/components/TodoCard';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { isOrgAccount } from '@/lib/orgAccount';
import { pickAddress, validateAddress, type StructuredAddress, type AddressField } from '@/lib/address';
import { useUnsavedGuard, shallowEqual } from '@/components/UnsavedChangesProvider';
import { mayDeclareAges } from '@/lib/person/adultDob';
import { PageLoader } from "@/components/ui/PageLoader";
import type { ContactWarning, EmergencyContact, HouseholdAnswer } from './household';
import { useEmergencyContactForm } from './useEmergencyContactForm';
import MembershipStatusAlert from './MembershipStatusAlert';
import NotRenewingControl from './NotRenewingControl';
import HouseholdMembersSection from './HouseholdMembersSection';
import AddMemberForm from './AddMemberForm';
import HouseholdAddressCard from './HouseholdAddressCard';
import EmergencyContactsCard from './EmergencyContactsCard';

const blankAddress: StructuredAddress = { line1: "", line2: "", city: "", state: "", postalCode: "" };

export default function HouseholdPage() {
  const { user: sessionUser, loading: authLoading, ready } = useRequireRole([]);

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
  const clearMessage = () => setMessage(null);

  const [address, setAddress] = useState<StructuredAddress>(blankAddress);
  // Snapshot of the address as last loaded/saved; isDirty compares it to current
  // state to drive the unsaved-changes guard.
  const [initialAddress, setInitialAddress] = useState<StructuredAddress>(blankAddress);
  const [addressErrors, setAddressErrors] = useState<Partial<Record<AddressField, string>>>({});
  const [savingSettings, setSavingSettings] = useState(false);

  const contactForm = useEmergencyContactForm();

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

  // Direction-B: a member change collided with an emergency contact. Surface the
  // warning and drop the lead straight into the add-contact form.
  const applyContactWarning = (warning: ContactWarning) => {
    if (!warning) return false;
    warn(`⚠️ ${warning.message}`);
    contactForm.startAdd();
    return true;
  };

  if ((householdAnswer === null && !householdError) || authLoading) {
    return <PageLoader />;
  }

  if (!ready) return null;

  // Staff (@innovationtreehouse.org) accounts aren't real member families; the add-member
  // control is hidden for them (server also enforces this — see /api/household PATCH).
  const isStaffAccount = isOrgAccount(sessionUser as { hd?: string | null; email?: string | null });

  return (
    <PageContainer>
      <Stack>
        <TodoCard />
        <Card withBorder radius="md" padding="lg">
          <Title order={1} mb="md">{household?.name || 'My Household'}</Title>

          {renewalError && <LoadError what="your renewal status" message={renewalError} onRetry={reloadRenewal} />}

          {household && (
            <MembershipStatusAlert orgMembership={household.orgMembership} renewalDue={renewalDue} validUntil={validUntil} viewerIsLead={viewerIsLead} />
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
              <HouseholdMembersSection
                members={household.householdMembers || []}
                userId={userId}
                viewerIsLead={viewerIsLead}
                agesLocked={agesLocked}
                boardReplyTo={boardReplyTo}
                onClearMessage={clearMessage}
                onWarn={warn}
                onContactWarning={applyContactWarning}
              />

              {!isStaffAccount && viewerIsLead && (
                <AddMemberForm onClearMessage={clearMessage} onContactWarning={applyContactWarning} />
              )}
            </>
          )}
        </Card>

        {household && viewerIsLead && (
          <HouseholdAddressCard
            address={address}
            onAddressChange={setAddress}
            errors={addressErrors}
            onErrorsChange={setAddressErrors}
            saving={savingSettings}
            onSave={handleSaveSettings}
          />
        )}

        {household && viewerIsLead && (
          <EmergencyContactsCard
            contacts={contacts}
            loaded={contactsAnswer !== null}
            loadError={contactsError}
            onRetry={fetchContacts}
            form={contactForm}
          />
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
