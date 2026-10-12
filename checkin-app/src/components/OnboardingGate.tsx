"use client";

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import { notifications } from '@mantine/notifications';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { isValidEmail } from '@/lib/emergencyContacts/identity';
import { isValidPhone, PHONE_ERROR } from '@/lib/phone';
import EmergencyContactNotice from '@/components/ui/EmergencyContactNotice';
import {
  Alert,
  Box,
  Button,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';

export default function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const pathname = usePathname();

  const [loading, setLoading] = useState(true);
  const [needsPhone, setNeedsPhone] = useState(false);
  const [needsEmergencyContact, setNeedsEmergencyContact] = useState(false);

  const [phone, setPhone] = useState('');
  const [emergencyContactName, setEmergencyContactName] = useState('');
  const [emergencyContactPhone, setEmergencyContactPhone] = useState('');
  const [emergencyContactEmail, setEmergencyContactEmail] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

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
    if (status === 'authenticated') {
      checkStatus();
    }
  }, [status, pathname, checkStatus]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (needsPhone && !isValidPhone(phone)) {
      setError(PHONE_ERROR);
      return;
    }
    if (needsEmergencyContact && !isValidPhone(emergencyContactPhone)) {
      setError(`Emergency contact: ${PHONE_ERROR}`);
      return;
    }
    if (needsEmergencyContact && emergencyContactEmail.trim() && !isValidEmail(emergencyContactEmail)) {
      setError("That emergency contact email doesn't look right.");
      return;
    }

    setSaving(true);
    setError('');

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

      const res = await fetch('/api/profile/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        // Check status again to dismiss the modal
        await checkStatus();
        notifyNavRefresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to save information');
      }
    } catch {
      notifications.show({ color: "red", message: "Network error", autoClose: false });
    } finally {
      setSaving(false);
    }
  };

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
                value={phone}
                onChange={(e) => setPhone(e.currentTarget.value)}
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
                    value={emergencyContactPhone}
                    onChange={(e) => setEmergencyContactPhone(e.currentTarget.value)}
                    required
                  />
                  <TextInput
                    type="email"
                    label="Contact Email (optional)"
                    placeholder="jane@example.com"
                    value={emergencyContactEmail}
                    onChange={(e) => setEmergencyContactEmail(e.currentTarget.value)}
                  />
                </Stack>
              </Paper>
            )}

            {error && (
              <Alert color="red" variant="light">
                {error}
              </Alert>
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
