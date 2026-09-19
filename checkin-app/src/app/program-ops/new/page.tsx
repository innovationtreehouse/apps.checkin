"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Box, Button, Card, Checkbox, Group, NumberInput, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRequireRole } from '@/hooks/useRequireRole';
import { AdminPageHeader } from '@/components/admin/AdminPageHeader';
import { EntityPicker } from '@/components/admin/EntityPicker';
import { useUnsavedGuard, shallowEqual } from '@/components/UnsavedChangesProvider';

import { PageLoader } from "@/components/ui/PageLoader";
type ParticipantOption = {
  id: number;
  name: string | null;
  email: string;
};

export default function CreateProgramPage() {
  const { ready, loading: authLoading } = useRequireRole(['isSysadmin', 'isBoardMember'], { redirectTo: '/system-status' });
  const router = useRouter();

  const [name, setName] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [minAge, setMinAge] = useState("");
  const [maxAge, setMaxAge] = useState("");
  const [isFree, setIsFree] = useState(true);
  const [memberPrice, setMemberPrice] = useState("");
  const [nonMemberPrice, setNonMemberPrice] = useState("");
  const [maxParticipants, setMaxParticipants] = useState("50");
  const [orgMemberOnly, setMemberOnly] = useState(false);
  const [publiclyVisible, setPubliclyVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState("");

  // Lead Mentor selection state (the EntityPicker owns the transient query/results)
  const [leadMentorId, setLeadMentorId] = useState("");
  const [mentorSearch, setMentorSearch] = useState("");

  // End date before start date is invalid (ISO date strings compare lexically).
  const datesInvalid = Boolean(startAt && endAt && endAt < startAt);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || datesInvalid) return;

    setSaving(true);
    setMessage("");

    try {
      const res = await fetch('/api/programs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          startAt,
          endAt,
          orgMemberOnly,
          publiclyVisible: orgMemberOnly && publiclyVisible,
          minAge: minAge ? parseInt(minAge) : null,
          maxAge: maxAge ? parseInt(maxAge) : null,
          memberPrice: (!isFree && memberPrice) ? memberPrice : null,
          nonMemberPrice: (!isFree && !orgMemberOnly && nonMemberPrice) ? nonMemberPrice : null,
          maxParticipants: parseInt(maxParticipants),
          leadMentorId: leadMentorId ? parseInt(leadMentorId) : null
        })
      });

      if (res.ok) {
        const data = await res.json();
        setSubmitted(true); // clear unsaved-changes guard before redirect
        router.push(`/program-ops/programs/${data.program.id}`);
      } else {
        const data = await res.json().catch(() => ({}));
        setMessage(data.error || "Failed to create program.");
        setSaving(false);
      }
    } catch {
      notifications.show({ color: "red", message: "Network error creating program.", autoClose: false });
      setSaving(false);
    }
  };

  // Dirty = any field changed from the blank creation defaults.
  const isDirty =
    !submitted &&
    !shallowEqual(
      { name: "", startAt: "", endAt: "", minAge: "", maxAge: "", isFree: true, memberPrice: "", nonMemberPrice: "", maxParticipants: "50", orgMemberOnly: false, publiclyVisible: false, leadMentorId: "" },
      { name, startAt, endAt, minAge, maxAge, isFree, memberPrice, nonMemberPrice, maxParticipants, orgMemberOnly, publiclyVisible, leadMentorId },
    );
  useUnsavedGuard(isDirty);

  if (authLoading) {
    return <PageLoader />;
  }

  if (!ready) return null;

  return (
    <Box pb="md">
      <Card withBorder radius="md" padding="lg">
        <AdminPageHeader title="Create Program" mb="md" />

        <Text c="dimmed" mb="lg">
          Create a new program. You can configure the roster and schedule events later.
        </Text>

        <form onSubmit={handleCreate}>
          <Stack>
            <TextInput
              label="Program Name"
              required
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="e.g. FRC Robotics 2026"
            />

            {/* Lead Mentor Selector */}
            <EntityPicker<ParticipantOption>
              label="Lead Mentor / Program Coordinator"
              required
              description="The lead mentor will be able to manage this program's roster and events."
              placeholder="Search by name, email, or ID..."
              selectedId={leadMentorId || null}
              selectedLabel={mentorSearch}
              search={async (q) => {
                const res = await fetch(`/api/people/search?q=${encodeURIComponent(q)}&filter=adults`);
                if (!res.ok) return [];
                const data = await res.json();
                return data.people || [];
              }}
              getOptionLabel={(p) => p.name || 'Unnamed'}
              getOptionDescription={(p) => p.email}
              onSelect={(p) => { setLeadMentorId(p.id.toString()); setMentorSearch(`${p.name || 'Unnamed'} (${p.email})`); }}
              onClear={() => { setLeadMentorId(""); setMentorSearch(""); }}
            />

            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <NumberInput label="Min Age (Optional)" value={minAge} onChange={(v) => setMinAge(String(v))} min={0} max={25} />
              <NumberInput label="Max Age (Optional)" value={maxAge} onChange={(v) => setMaxAge(String(v))} min={0} max={25} />
            </SimpleGrid>

            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                type="date"
                label="Start Date"
                required
                value={startAt}
                onChange={(e) => setStartAt(e.currentTarget.value)}
                error={datesInvalid}
                styles={datesInvalid ? { input: { color: 'var(--mantine-color-red-7)' } } : undefined}
              />
              <TextInput
                type="date"
                label="End Date"
                required
                value={endAt}
                onChange={(e) => setEndAt(e.currentTarget.value)}
                error={datesInvalid ? 'End date must be on or after start date.' : false}
                styles={datesInvalid ? { input: { color: 'var(--mantine-color-red-7)' } } : undefined}
              />
            </SimpleGrid>

            <Card withBorder radius="md" padding="md">
              <Checkbox
                checked={isFree}
                onChange={(e) => {
                  setIsFree(e.currentTarget.checked);
                  if (e.currentTarget.checked) {
                    setMemberPrice("");
                    setNonMemberPrice("");
                  }
                }}
                label="This is a free program"
              />
            </Card>

            {!isFree && (
              <>
                <SimpleGrid cols={{ base: 1, sm: orgMemberOnly ? 1 : 2 }}>
                  <NumberInput label="Treehouse Member Price ($)" value={memberPrice} onChange={(v) => setMemberPrice(String(v))} min={0} placeholder="0" />
                  {!orgMemberOnly && (
                    <NumberInput label="Non-Member Price ($)" value={nonMemberPrice} onChange={(v) => setNonMemberPrice(String(v))} min={0} placeholder="0" />
                  )}
                </SimpleGrid>
                <Text size="xs" c="dimmed">Setting a price automatically creates a checkout flow on Shopify.</Text>
                {!orgMemberOnly && Number(memberPrice) > Number(nonMemberPrice) && (
                  <Alert color="yellow" variant="light">⚠️ Member price is higher than non-member price.</Alert>
                )}
              </>
            )}

            <NumberInput
              label="Max Participants"
              required
              value={maxParticipants}
              onChange={(v) => setMaxParticipants(String(v))}
              min={1}
              description="Sets the inventory limit on Shopify."
            />

            <Checkbox
              checked={orgMemberOnly}
              onChange={(e) => setMemberOnly(e.currentTarget.checked)}
              label="Treehouse Members-Only Program"
              description="If checked, only Treehouse Members can enroll."
            />

            {orgMemberOnly && (
              <Checkbox
                ml="lg"
                checked={publiclyVisible}
                onChange={(e) => setPubliclyVisible(e.currentTarget.checked)}
                label="Show to non-members"
                description="List this members-only program publicly so non-members can see it. They still must be a member to enroll."
              />
            )}

            {message && (
              <Alert color="red" variant="light" title="Couldn't create program">{message}</Alert>
            )}

            <Group justify="flex-end">
              <Button type="submit" disabled={saving || !name.trim() || !leadMentorId || !startAt || !endAt || !maxParticipants || datesInvalid} loading={saving}>
                Create Program
              </Button>
            </Group>
          </Stack>
        </form>
      </Card>
    </Box>
  );
}
