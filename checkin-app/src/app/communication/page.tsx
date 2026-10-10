"use client";

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Alert, Card, Checkbox, Stack, Text, Title, Tooltip } from '@mantine/core';
import { PageContainer } from '@/components/ui/PageContainer';
import { notifications } from '@mantine/notifications';

import { PageLoader } from "@/components/ui/PageLoader";
const OPTIONS = [
  { key: 'emailCheckinReceipts', label: 'Email me when I check in or out' },
  { key: 'emailDependentCheckins', label: 'Email me realtime receipts when my dependents check in/out' },
  { key: 'notifyNewPrograms', label: 'Notify me when a new program is announced' },
] as const;

export default function CommunicationPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const hasEmail = !!session?.user?.email;

  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const [settings, setSettings] = useState({
    emailCheckinReceipts: false,
    emailDependentCheckins: false,
    notifyNewPrograms: true
  });
  const [emailSuppressed, setEmailSuppressed] = useState(false);

  const fetchSettings = useCallback(() => fetch('/api/profile')
    .then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        const s = data.profile.notificationSettings || {};
        setSettings({
          emailCheckinReceipts: s.emailCheckinReceipts || false,
          emailDependentCheckins: s.emailDependentCheckins || false,
          notifyNewPrograms: s.notifyNewPrograms !== undefined ? s.notifyNewPrograms : true
        });
        setEmailSuppressed(!!data.profile.emailSuppressed);
      } else {
        setMessage("Failed to load settings.");
      }
    })
    .catch(() => {
      notifications.show({ color: "red", message: "Network error loading settings.", autoClose: false });
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push('/');
    } else if (status === "authenticated") {
      fetchSettings();
    }
  }, [status, router, fetchSettings]);

  // Each toggle persists immediately — no save button. Optimistic flip,
  // revert on failure so a checkbox never lies about what's in the DB.
  const persist = async (patch: Partial<typeof settings>) => {
    const prev = settings;
    const next = { ...settings, ...patch };
    setSettings(next);
    setMessage("");
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationSettings: next })
      });
      if (!res.ok) throw new Error();
    } catch {
      setSettings(prev);
      setMessage("Failed to update settings.");
    }
  };

  // Same immediate-persist / revert-on-failure pattern as the checkboxes above, for the
  // one field that isn't inside notificationSettings.
  const persistSuppression = async (value: boolean) => {
    const prev = emailSuppressed;
    setEmailSuppressed(value);
    setMessage("");
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailSuppressed: value })
      });
      if (!res.ok) throw new Error();
    } catch {
      setEmailSuppressed(prev);
      setMessage("Failed to update settings.");
    }
  };

  if (loading || status === "loading") {
    return <PageLoader />;
  }

  if (!session) return null; // Fallback while router redirects

  return (
    <PageContainer>
      <Card withBorder radius="md" padding="lg" maw={620}>
        <Title order={1}>Communication</Title>
        <Text c="dimmed" mb="lg">Manage your email and notification preferences.</Text>

        <Stack>
          {/* Every preference is delivered by email, so all are disabled without one. */}
          {OPTIONS.map((opt) => (
            <Tooltip
              key={opt.key}
              label="Add an email to enable communication"
              disabled={hasEmail}
            >
              <Checkbox
                checked={settings[opt.key]}
                disabled={!hasEmail}
                onChange={(e) => persist({ [opt.key]: e.currentTarget.checked })}
                label={opt.label}
              />
            </Tooltip>
          ))}
        </Stack>

        <Stack mt="lg">
          <Checkbox
            checked={emailSuppressed}
            onChange={(e) => persistSuppression(e.currentTarget.checked)}
            label="Don't email me membership join/renewal invitations"
          />
        </Stack>

        {message && <Alert color="red" mt="md">{message}</Alert>}
      </Card>
    </PageContainer>
  );
}
