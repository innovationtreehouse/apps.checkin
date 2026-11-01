"use client";

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Alert, Card, Checkbox, Stack, Text, Title, Tooltip } from '@mantine/core';
import { PageContainer } from '@/components/ui/PageContainer';
import { LoadError } from "@checkin/component-ui";
import { useLoad } from "@/lib/api";
import { useSeedForm } from "@/hooks/useSeedForm";

import { PageLoader } from "@/components/ui/PageLoader";
const OPTIONS = [
  { key: 'emailCheckinReceipts', label: 'Email me when I check in or out' },
  { key: 'emailDependentCheckins', label: 'Email me realtime receipts when my dependents check in/out' },
  { key: 'notifyNewPrograms', label: 'Notify me when a new program is announced' },
  { key: 'emailPurchaseOutcomes', label: 'Email me about my receipts and reimbursements' },
] as const;

interface Profile {
  notificationSettings?: {
    emailCheckinReceipts?: boolean;
    emailDependentCheckins?: boolean;
    notifyNewPrograms?: boolean;
    emailPurchaseOutcomes?: boolean;
  } | null;
  emailSuppressed?: boolean;
}

export default function CommunicationPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const hasEmail = !!session?.user?.email;

  const [message, setMessage] = useState("");

  const [settings, setSettings] = useState({
    emailCheckinReceipts: false,
    emailDependentCheckins: false,
    notifyNewPrograms: true,
    emailPurchaseOutcomes: true,
  });
  const [emailSuppressed, setEmailSuppressed] = useState(false);

  // Counts toggles still saving; a refetch landing meanwhile must not flip them back.
  const [saving, setSaving] = useState(0);
  const { data, error, reload } = useLoad<{ profile: Profile }>(status === "authenticated" ? '/api/profile' : null);
  useSeedForm(data, saving > 0, ({ profile }) => {
    const s = profile.notificationSettings || {};
    setSettings({
      emailCheckinReceipts: s.emailCheckinReceipts || false,
      emailDependentCheckins: s.emailDependentCheckins || false,
      notifyNewPrograms: s.notifyNewPrograms !== undefined ? s.notifyNewPrograms : true,
      emailPurchaseOutcomes: s.emailPurchaseOutcomes !== false,
    });
    setEmailSuppressed(!!profile.emailSuppressed);
  });

  useEffect(() => {
    if (status === "unauthenticated") router.push('/');
  }, [status, router]);

  // Each toggle persists immediately — no save button. Optimistic flip,
  // revert on failure so a checkbox never lies about what's in the DB.
  const persist = async (patch: Partial<typeof settings>) => {
    const prev = settings;
    const next = { ...settings, ...patch };
    setSettings(next);
    setMessage("");
    setSaving((n) => n + 1);
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationSettings: next })
      });
      if (!res.ok) throw new Error();
      reload();
    } catch {
      setSettings(prev);
      setMessage("Failed to update settings.");
    } finally {
      setSaving((n) => n - 1);
    }
  };

  // Same immediate-persist / revert-on-failure pattern as the checkboxes above, for the
  // one field that isn't inside notificationSettings.
  const persistSuppression = async (value: boolean) => {
    const prev = emailSuppressed;
    setEmailSuppressed(value);
    setMessage("");
    setSaving((n) => n + 1);
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailSuppressed: value })
      });
      if (!res.ok) throw new Error();
      reload();
    } catch {
      setEmailSuppressed(prev);
      setMessage("Failed to update settings.");
    } finally {
      setSaving((n) => n - 1);
    }
  };

  if (status === "loading" || (!data && !error)) {
    return <PageLoader />;
  }

  if (!session) return null; // Fallback while router redirects

  return (
    <PageContainer>
      <Card withBorder radius="md" padding="lg" maw={620}>
        <Title order={1}>Communication</Title>
        <Text c="dimmed" mb="lg">Manage your email and notification preferences.</Text>

        {error && <LoadError what="your settings" message={error} onRetry={reload} />}

        {data && (<>
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
        </>)}

        {message && <Alert color="red" mt="md">{message}</Alert>}
      </Card>
    </PageContainer>
  );
}
