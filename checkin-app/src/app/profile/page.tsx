"use client";

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Anchor, Button, Card, Checkbox, Stack, Text, TextInput, Title } from '@mantine/core';
import { PageContainer } from '@/components/ui/PageContainer';
import { AlertBanner, type AlertTone } from '@/components/admin/AlertBanner';
import { notifications } from '@mantine/notifications';
import { isYouth } from '@/lib/time';
import { signInEmailHelp } from '@/lib/person/signInEmail';

import { PageLoader } from "@/components/ui/PageLoader";
export default function ProfilePage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: AlertTone } | null>(null);
  const [boardReplyTo, setBoardReplyTo] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    nickname: "",
    email: "",
    phone: "",
    dob: "",
    over25: false
  });
  const fetchProfile = useCallback(() => fetch('/api/profile')
    .then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setForm({
          name: data.profile.name || "",
          nickname: data.profile.nickname || "",
          email: data.profile.email || "",
          phone: data.profile.phone || "",
          dob: data.profile.dateOfBirth ? new Date(data.profile.dateOfBirth).toISOString().split('T')[0] : "",
          over25: !data.profile.dateOfBirth && !!data.profile.isDeclaredAdult
        });
      } else {
        setMessage({ text: "Failed to load profile.", tone: "error" });
      }
    })
    .catch(() => {
      notifications.show({ color: "red", message: "Network error loading profile.", autoClose: false });
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push('/');
    } else if (status === "authenticated") {
      fetchProfile();
      fetch('/api/household')
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => setBoardReplyTo(data?.boardReplyTo ?? null))
        .catch(() => {});
    }
  }, [status, router, fetchProfile]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          nickname: form.nickname,
          phone: form.phone,
          dob: form.over25 ? null : (form.dob || null),
          over25: form.over25
        })
      });

      if (res.ok) {
        notifications.show({ message: "Profile updated successfully!" });
      } else {
        const data = await res.json().catch(() => ({}));
        setMessage({ text: data.error || "Failed to update profile.", tone: "error" });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error saving profile.", autoClose: false });
    } finally {
      setSaving(false);
    }
  };

  if (loading || status === "loading") {
    return <PageLoader />;
  }

  if (!session) return null; // Fallback while router redirects

  const readOnly = isYouth(form.dob);

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
              <TextInput label="Full Name" description="Printed on name badges exactly as typed — please double-check the spelling." required value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} placeholder="e.g. Jane Doe" disabled={readOnly} />
              <TextInput label="Nickname (optional)" description="Printed on your name badge in place of your first name. Leave blank to use your first name." value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.currentTarget.value })} placeholder="e.g. Janey" disabled={readOnly} />
              <TextInput type="tel" label="Phone Number" required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.currentTarget.value })} placeholder="(555) 123-4567" disabled={readOnly} />
              <Checkbox
                label="I am over 25"
                checked={form.over25}
                disabled={readOnly}
                onChange={(e) => setForm({ ...form, over25: e.currentTarget.checked, dob: e.currentTarget.checked ? "" : form.dob })}
              />
              {!form.over25 && (
                <TextInput type="date" label="Date of Birth" value={form.dob} onChange={(e) => setForm({ ...form, dob: e.currentTarget.value })} disabled={readOnly} />
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

          <AlertBanner message={message?.text} tone={message?.tone} mb="md" />
      </Card>
    </PageContainer>
  );
}
