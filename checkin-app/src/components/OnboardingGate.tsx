"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { signOut, useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import { errorMessage, showError } from '@checkin/component-ui';
import { api, useLoad } from '@/lib/api';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { isValidEmail } from '@/lib/emergencyContacts/identity';
import { isValidPhone, PHONE_ERROR } from '@/lib/phone';
import EmergencyContactNotice from '@/components/ui/EmergencyContactNotice';
import {
  Alert,
  Box,
  Button,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';

function HouseholdQuestion() {
  const { data, error: loadError } = useLoad<{ household: { name: string } | null }>('/api/profile/household-question', { expireOn401: false });
  const householdName = data?.household?.name ?? null;
  const [saving, setSaving] = useState(false);

  const answer = async (join: boolean) => {
    setSaving(true);
    try {
      await api('/api/profile/household-question', { method: 'POST', body: JSON.stringify({ join }) });
      if (join) {
        window.location.reload();
      } else {
        await signOut({ callbackUrl: '/signin' });
      }
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box p="xl">
      <Paper withBorder p="lg" maw={520} mx="auto">
        <Stack>
          <Title order={3}>Join this household?</Title>
          <Text>
            A household added your email address{householdName ? `: ${householdName}` : ''}. Do you want to join it?
          </Text>
          <Text size="sm" c="dimmed">
            If you say no, you get a new record of your own and sign in again.
          </Text>
          {loadError && <Alert color="red">Could not load this question. Please try again.</Alert>}
          <Group>
            <Button loading={saving} onClick={() => answer(true)}>Yes, join</Button>
            <Button loading={saving} variant="default" onClick={() => answer(false)}>No</Button>
          </Group>
        </Stack>
      </Paper>
    </Box>
  );
}

export default function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const joinPending = session?.user?.householdJoinPending === true;
  const pathname = usePathname();

  const [loading, setLoading] = useState(true);
  const [needsPhone, setNeedsPhone] = useState(false);
  const [needsEmergencyContact, setNeedsEmergencyContact] = useState(false);

  const [phone, setPhone] = useState('');
  const [emergencyContactName, setEmergencyContactName] = useState('');
  const [emergencyContactPhone, setEmergencyContactPhone] = useState('');
  const [emergencyContactEmail, setEmergencyContactEmail] = useState('');

  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ phone?: string; contactPhone?: string; contactEmail?: string }>({});
  const phoneRef = useRef<HTMLInputElement>(null);
  const contactPhoneRef = useRef<HTMLInputElement>(null);
  const contactEmailRef = useRef<HTMLInputElement>(null);

  const checkStatus = useCallback(() => fetch('/api/profile/onboarding-status')
    .then(async (res) => {
      if (res.ok) {
        const data = await res.json();

        if (sessionStorage.getItem('onboarding_skipped') !== 'true') {
          setNeedsPhone(data.needsPhone);
          setNeedsEmergencyContact(data.needsEmergencyContact);
        }
      }
    })
    .catch((err) => {
      console.error('Failed to check onboarding status', err);
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  useEffect(() => {
    if (status === 'authenticated' && !joinPending) {
      checkStatus();
    }
  }, [status, joinPending, pathname, checkStatus]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const errors = {
      phone: needsPhone && !isValidPhone(phone) ? PHONE_ERROR : undefined,
      contactPhone: needsEmergencyContact && !isValidPhone(emergencyContactPhone) ? PHONE_ERROR : undefined,
      contactEmail: needsEmergencyContact && emergencyContactEmail.trim() && !isValidEmail(emergencyContactEmail)
        ? "That email doesn't look right."
        : undefined,
    };
    setFieldErrors(errors);
    const firstBroken = errors.phone ? phoneRef : errors.contactPhone ? contactPhoneRef : errors.contactEmail ? contactEmailRef : null;
    if (firstBroken) {
      firstBroken.current?.focus();
      return;
    }

    setSaving(true);

    try {
      const payload: Record<string, string> = {};
      if (needsPhone && phone.trim()) {
        payload.phone = phone.trim();
      }
      if (needsEmergencyContact && emergencyContactName.trim() && emergencyContactPhone.trim()) {
        payload.emergencyContactName = emergencyContactName.trim();
        payload.emergencyContactPhone = emergencyContactPhone.trim();
        if (emergencyContactEmail.trim()) payload.emergencyContactEmail = emergencyContactEmail.trim();
      }

      await api('/api/profile/onboarding', { method: 'POST', body: JSON.stringify(payload) });
      // Check status again to dismiss the modal
      await checkStatus();
      notifyNavRefresh();
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (joinPending) return <HouseholdQuestion />;

  const isBlocked = !loading && (needsPhone || needsEmergencyContact);

  return (
    <>
      {children}
      <Modal
        opened={isBlocked}
        onClose={() => {}}
        withCloseButton={false}
        closeOnClickOutside={false}
        closeOnEscape={false}
        centered
        size="lg"
        title="Action Required"
      >
        <Text c="dimmed" mb="lg">
          To ensure the safety of our facility and compliance with our policies, we need a bit
          more contact information before you can proceed.
        </Text>

        <form onSubmit={handleSubmit}>
          <Stack>
            {needsPhone && (
              <TextInput
                type="tel"
                label="Your Phone Number"
                description="Required for all adult participants."
                placeholder="(555) 123-4567"
                ref={phoneRef}
                value={phone}
                error={fieldErrors.phone}
                onChange={(e) => { setPhone(e.currentTarget.value); setFieldErrors((f) => ({ ...f, phone: undefined })); }}
                required
              />
            )}

            {needsEmergencyContact && (
              <Paper withBorder p="md" radius="md">
                <Title order={5} mb="xs">
                  Household Emergency Contact
                </Title>
                <Text size="sm" c="dimmed" mb="sm">
                  As a household lead, you must designate an emergency contact for your household
                  members.
                </Text>
                <EmergencyContactNotice mb="md" />
                <Stack>
                  <TextInput
                    label="Contact Name"
                    placeholder="Jane Doe"
                    value={emergencyContactName}
                    onChange={(e) => setEmergencyContactName(e.currentTarget.value)}
                    required
                  />
                  <TextInput
                    type="tel"
                    label="Contact Phone"
                    placeholder="(555) 987-6543"
                    ref={contactPhoneRef}
                    value={emergencyContactPhone}
                    error={fieldErrors.contactPhone}
                    onChange={(e) => { setEmergencyContactPhone(e.currentTarget.value); setFieldErrors((f) => ({ ...f, contactPhone: undefined })); }}
                    required
                  />
                  <TextInput
                    type="email"
                    label="Contact Email (optional)"
                    placeholder="jane@example.com"
                    ref={contactEmailRef}
                    value={emergencyContactEmail}
                    error={fieldErrors.contactEmail}
                    onChange={(e) => { setEmergencyContactEmail(e.currentTarget.value); setFieldErrors((f) => ({ ...f, contactEmail: undefined })); }}
                  />
                </Stack>
              </Paper>
            )}

            <Box>
              <Button type="submit" fullWidth loading={saving}>
                Save &amp; Continue
              </Button>
              <Button
                type="button"
                variant="subtle"
                color="gray"
                fullWidth
                mt="xs"
                disabled={saving}
                onClick={() => {
                  sessionStorage.setItem('onboarding_skipped', 'true');
                  setNeedsPhone(false);
                  setNeedsEmergencyContact(false);
                }}
              >
                Ask me next time
              </Button>
            </Box>
          </Stack>
        </form>
      </Modal>
    </>
  );
}
