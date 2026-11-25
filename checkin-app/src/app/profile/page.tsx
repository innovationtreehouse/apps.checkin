"use client";

import { useState, useEffect } from 'react';
import { useOrgTime } from "@/components/TimezoneProvider";
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Anchor, Button, Card, Checkbox, Stack, Text, TextInput, Title } from '@mantine/core';
import { PageContainer } from '@/components/ui/PageContainer';
import { errorMessage, LoadError, showError, showSuccess } from '@checkin/component-ui';
import { useSeedForm } from '@/hooks/useSeedForm';
import { api, useLoad } from '@/lib/api';
import { isYouth } from '@/lib/time';
import { AGE_LEAD_ONLY_REFUSAL, mayDeclareAges } from '@/lib/person/adultDob';
import { signInEmailHelp } from '@/lib/person/signInEmail';

import { PageLoader } from "@/components/ui/PageLoader";

interface Profile {
  name: string | null;
  nickname: string | null;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  isDeclaredAdult: boolean | null;
}

export default function ProfilePage() {
  const today = useOrgTime().today();
  const { data: session, status } = useSession();
  const router = useRouter();

  const signedIn = status === "authenticated";
  const { data, error, reload } = useLoad<{ profile: Profile }>(signedIn ? '/api/profile' : null);
  // The household read supplies the sign-in email help text and who leads the household; its failure leaves the defaults.
  const { data: household } = useLoad<{ boardReplyTo?: string | null; household?: { householdMembers?: { id: number; isHouseholdLead?: boolean }[] } | null }>(signedIn ? '/api/household' : null);
  const boardReplyTo = household?.boardReplyTo ?? null;
  const userId = session?.user?.id;
  const agesLocked = userId !== undefined
    && !mayDeclareAges(userId, (household?.household?.householdMembers ?? []).filter((m) => m.isHouseholdLead).map((m) => m.id));
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [form, setForm] = useState({
    name: "",
    nickname: "",
    email: "",
    phone: "",
    dob: "",
    over25: false
  });
  useSeedForm(data, dirty, ({ profile }) => setForm({
    name: profile.name || "",
    nickname: profile.nickname || "",
    email: profile.email || "",
    phone: profile.phone || "",
    dob: profile.dateOfBirth ? new Date(profile.dateOfBirth).toISOString().split('T')[0] : "",
    over25: !profile.dateOfBirth && !!profile.isDeclaredAdult
  }));
  const edit = (next: typeof form) => { setDirty(true); setForm(next); };

  useEffect(() => {
    if (status === "unauthenticated") router.push('/');
  }, [status, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      await api('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          name: form.name,
          nickname: form.nickname,
          phone: form.phone,
          ...(!agesLocked && { dob: form.over25 ? null : (form.dob || null), over25: form.over25 })
        })
      });
      showSuccess("Profile updated successfully!");
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (status === "loading") return <PageLoader />;

  if (!session) return null; // Fallback while router redirects

  if (error) {
    return (
      <PageContainer>
        <LoadError what="your profile" message={error} onRetry={reload} />
      </PageContainer>
    );
  }

  if (!data) return <PageLoader />;

  const readOnly = isYouth(form.dob, today);

  return (
    <PageContainer>
      <Card withBorder radius="md" padding="lg" maw={620}>
        <Title order={1}>My Profile</Title>
          <Text c="dimmed" mb="lg">
            {readOnly
              ? "View your personal information. Ask a parent or staff member to make changes."
              : "Manage your personal information and contact details."}
          </Text>

          <form onSubmit={handleSubmit}>
            <Stack>
              <TextInput label="Email Address" value={form.email} disabled description={signInEmailHelp(boardReplyTo)} />
              <TextInput label="Full Name" description="Printed on name badges exactly as typed — please double-check the spelling." required value={form.name} onChange={(e) => edit({ ...form, name: e.currentTarget.value })} placeholder="e.g. Jane Doe" disabled={readOnly} />
              <TextInput label="Nickname (optional)" description="Printed on your name badge in place of your first name. Leave blank to use your first name." value={form.nickname} onChange={(e) => edit({ ...form, nickname: e.currentTarget.value })} placeholder="e.g. Janey" disabled={readOnly} />
              <TextInput type="tel" label="Phone Number" required value={form.phone} onChange={(e) => edit({ ...form, phone: e.currentTarget.value })} placeholder="(555) 123-4567" disabled={readOnly} />
              <Checkbox
                label="I am over 25"
                checked={form.over25}
                disabled={readOnly || agesLocked}
                description={agesLocked ? AGE_LEAD_ONLY_REFUSAL : undefined}
                onChange={(e) => edit({ ...form, over25: e.currentTarget.checked, dob: e.currentTarget.checked ? "" : form.dob })}
              />
              {!form.over25 && (
                <TextInput type="date" label="Date of Birth" value={form.dob} onChange={(e) => edit({ ...form, dob: e.currentTarget.value })} disabled={readOnly || agesLocked} />
              )}

              <Text size="sm" c="dimmed">
                Your address is managed on the <Anchor href="/my-household">Household</Anchor> page.
              </Text>

              {!readOnly && (
                <Button type="submit" disabled={saving} loading={saving} mt="sm">
                  Save Profile
                </Button>
              )}
            </Stack>
          </form>
      </Card>
    </PageContainer>
  );
}
