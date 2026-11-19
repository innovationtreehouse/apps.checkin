"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { signOut, useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import { errorMessage, HttpError, showError } from '@checkin/component-ui';
import { api, useLoad } from '@/lib/api';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { isValidEmail } from '@/lib/emergencyContacts/identity';
import { isValidPhone, PHONE_ERROR } from '@/lib/phone';
import EmergencyContactNotice from '@/components/ui/EmergencyContactNotice';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';

// The onboarding inputs in form order, named by their request keys so a server refusal's `fields` maps straight onto them.
const FIELD_NAMES = ['phone', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactEmail'] as const;
type FieldName = typeof FIELD_NAMES[number];
type FieldErrors = Partial<Record<FieldName, string>>;

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

/** Whether a signed-in session must give an age before any page: someone who created a new household and has no age on file yet. */
export function needsAgeStep(user: { ageStepPending?: boolean; denied?: boolean; householdJoinPending?: boolean } | undefined): boolean {
  return user?.ageStepPending === true && !user.denied && !user.householdJoinPending;
}

function AgeStep() {
  const [dob, setDob] = useState('');
  const [over25, setOver25] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!over25 && !dob) {
      setError('Enter your date of birth, or tick "I am over 25".');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ dob: over25 ? null : dob, over25 }) });
      window.location.reload();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Box p="xl">
      <Paper withBorder p="lg" maw={520} mx="auto">
        <form onSubmit={save}>
          <Stack>
            <Title order={3}>Your date of birth</Title>
            <Text>We need your age on file before you carry on.</Text>
            <Checkbox
              label="I am over 25"
              checked={over25}
              onChange={(e) => { setOver25(e.currentTarget.checked); setError(null); }}
            />
            {!over25 && (
              <TextInput
                type="date"
                label="Date of birth"
                value={dob}
                onChange={(e) => { setDob(e.currentTarget.value); setError(null); }}
              />
            )}
            {error && <Alert color="red">{error}</Alert>}
            <Group>
              <Button type="submit" loading={saving}>Save &amp; continue</Button>
              <Button variant="default" disabled={saving} onClick={() => signOut({ callbackUrl: '/signin' })}>Sign out</Button>
            </Group>
          </Stack>
        </form>
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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const phoneRef = useRef<HTMLInputElement>(null);
  const contactNameRef = useRef<HTMLInputElement>(null);
  const contactPhoneRef = useRef<HTMLInputElement>(null);
  const contactEmailRef = useRef<HTMLInputElement>(null);
  const fieldRefs: Record<FieldName, React.RefObject<HTMLInputElement | null>> = {
    phone: phoneRef,
    emergencyContactName: contactNameRef,
    emergencyContactPhone: contactPhoneRef,
    emergencyContactEmail: contactEmailRef,
  };
  const clearFieldError = (name: FieldName) => setFieldErrors((f) => ({ ...f, [name]: undefined }));
  const flagFields = (errors: FieldErrors) => {
    setFieldErrors(errors);
    const firstBroken = FIELD_NAMES.find((name) => errors[name]);
    if (firstBroken) fieldRefs[firstBroken].current?.focus();
    return firstBroken !== undefined;
  };

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

    const brokenInput = flagFields({
      phone: needsPhone && !isValidPhone(phone) ? PHONE_ERROR : undefined,
      emergencyContactPhone: needsEmergencyContact && !isValidPhone(emergencyContactPhone) ? PHONE_ERROR : undefined,
      emergencyContactEmail: needsEmergencyContact && emergencyContactEmail.trim() && !isValidEmail(emergencyContactEmail)
        ? "That email doesn't look right."
        : undefined,
    });
    if (brokenInput) return;

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
      const refused: FieldErrors = {};
      if (err instanceof HttpError) {
        for (const name of FIELD_NAMES) if (err.fields.includes(name)) refused[name] = err.message;
      }
      if (!flagFields(refused)) showError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (joinPending) return <HouseholdQuestion />;
  if (needsAgeStep(session?.user)) return <AgeStep />;

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
                onChange={(e) => { setPhone(e.currentTarget.value); clearFieldError('phone'); }}
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
                    ref={contactNameRef}
                    value={emergencyContactName}
                    error={fieldErrors.emergencyContactName}
                    onChange={(e) => { setEmergencyContactName(e.currentTarget.value); clearFieldError('emergencyContactName'); }}
                    required
                  />
                  <TextInput
                    type="tel"
                    label="Contact Phone"
                    placeholder="(555) 987-6543"
                    ref={contactPhoneRef}
                    value={emergencyContactPhone}
                    error={fieldErrors.emergencyContactPhone}
                    onChange={(e) => { setEmergencyContactPhone(e.currentTarget.value); clearFieldError('emergencyContactPhone'); }}
                    required
                  />
                  <TextInput
                    type="email"
                    label="Contact Email (optional)"
                    placeholder="jane@example.com"
                    ref={contactEmailRef}
                    value={emergencyContactEmail}
                    error={fieldErrors.emergencyContactEmail}
                    onChange={(e) => { setEmergencyContactEmail(e.currentTarget.value); clearFieldError('emergencyContactEmail'); }}
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
