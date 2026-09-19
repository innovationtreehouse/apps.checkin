"use client";

import { use, useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useRequireRole } from '@/hooks/useRequireRole';
import { Alert, Badge, Box, Button, Card, Checkbox, Container, Divider, Group, NumberInput, Select, SimpleGrid, Stack, Tabs, Text, TextInput, Title } from '@mantine/core';
import { AlertBanner } from '@/components/admin/AlertBanner';
import { EntityPicker } from '@/components/admin/EntityPicker';
import { ScrollableTabsList } from '@/components/ui/ScrollableTabsList';
import { ProgramRosterTab } from './ProgramRosterTab';
import { notifications } from '@mantine/notifications';
import { ProgramEventsTab } from './ProgramEventsTab';
import { isProgramCheckoutBroken } from '@/lib/programCheckout';
import { notifyNavRefresh } from '@/lib/nav-refresh';

import { PageLoader } from "@/components/ui/PageLoader";
export type ProgramDetail = {
  id: number;
  name: string;
  startAt: string | null;
  endAt: string | null;
  leadMentorId: number | null;
  phase: string;
  enrollmentStatus: string;
  minAge: number | null;
  maxAge: number | null;
  maxParticipants: number | null;
  orgMemberOnly: boolean;
  publiclyVisible: boolean;
  announceOnOpen: boolean;
  participants: {
    personId: number;
    status: string;
    pendingSince: string | null;
    person: {
      name: string | null;
      email: string;
      phone?: string | null;
      // householdMembers is the household's leads (the parents) only. Contact
      // fields are optional because the response stripper drops them for a
      // viewer without the grant.
      household?: {
        householdMembers?: { id: number; name: string | null; email?: string | null; phone?: string | null }[];
        emergencyContacts: { id: number; name: string; phone: string; relationship: string | null }[];
      } | null;
    };
  }[];
  volunteers: { personId: number; isCore: boolean; person: { name: string | null; email: string } }[];
  events: { id: number; name: string; startAt: string; endAt: string; attendanceConfirmedAt: string | null }[];
  leadMentor: { name: string | null; email: string } | null;
  orgMemberPriceCents: number | null;
  nonOrgMemberPriceCents: number | null;
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
};

export type ParticipantOption = { id: number; name: string | null; email: string; dateOfBirth?: string | null };

const PHASE_BADGE: Record<string, { label: string; color: string }> = {
  PLANNING: { label: 'Planning', color: 'gray' },
  UPCOMING: { label: 'Upcoming', color: 'yellow' },
  RUNNING: { label: 'Running', color: 'cyan' },
  FINISHED: { label: 'Finished', color: 'teal' },
};

function mentorLabel(name: string | null, email: string): string {
  const label = name || 'Unnamed';
  return email ? `${label} (${email})` : label;
}

export default function ProgramDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user: sessionUser, loading: authLoading, ready } = useRequireRole([]);
  const router = useRouter();

  const [program, setProgram] = useState<ProgramDetail | null>(null);

  // Form States
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [minAge, setMinAge] = useState("");
  const [maxAge, setMaxAge] = useState("");
  const [maxParticipants, setMaxParticipants] = useState("");
  const [phase, setPhase] = useState("PLANNING");
  const [enrollmentStatus, setEnrollmentStatus] = useState("CLOSED");
  const [orgMemberOnly, setMemberOnly] = useState(false);
  const [publiclyVisible, setPubliclyVisible] = useState(false);
  const [announceOnOpen, setAnnounceOnOpen] = useState(false);
  const [leadMentorIdInput, setLeadMentorIdInput] = useState("");
  const [memberPrice, setMemberPrice] = useState("");
  const [nonMemberPrice, setNonMemberPrice] = useState("");

  // Shopify identifiers, editable by sysadmin/board only (manual repair when
  // there's no live Shopify to sync against).
  const [shopifyProductIdInput, setShopifyProductIdInput] = useState("");
  const [variantInput, setVariantInput] = useState("");

  // EntityPicker owns the transient query/results/loading; we keep only the selected id + its display label.
  const [mentorSearch, setMentorSearch] = useState("");
  const [isEditingMentor, setIsEditingMentor] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [message, setMessage] = useState("");
  const [activeTab, setActiveTab] = useState<'general' | 'roster' | 'events'>('general');

  const fetchProgram = useCallback(async () => {
    try {
      const res = await fetch(`/api/programs/${id}`);
      if (res.ok) {
        const data = await res.json();
        setProgram(data);
        setStartAt(data.startAt ? data.startAt.split('T')[0] : "");
        setEndAt(data.endAt ? data.endAt.split('T')[0] : "");
        setMinAge(data.minAge !== null ? String(data.minAge) : "");
        setMaxAge(data.maxAge !== null ? String(data.maxAge) : "");
        setMaxParticipants(data.maxParticipants !== null ? String(data.maxParticipants) : "");
        setPhase(data.phase || "PLANNING");
        setEnrollmentStatus(data.enrollmentStatus || "CLOSED");
        setMemberOnly(Boolean(data.orgMemberOnly));
        setPubliclyVisible(Boolean(data.publiclyVisible));
        setAnnounceOnOpen(Boolean(data.announceOnOpen));
        setLeadMentorIdInput(data.leadMentorId !== null ? String(data.leadMentorId) : "");
        setMemberPrice(data.orgMemberPriceCents !== null ? String(data.orgMemberPriceCents / 100) : "");
        setNonMemberPrice(data.nonOrgMemberPriceCents !== null ? String(data.nonOrgMemberPriceCents / 100) : "");
        setMentorSearch(data.leadMentor ? mentorLabel(data.leadMentor.name, data.leadMentor.email) : "");
        setShopifyProductIdInput(data.shopifyProductId ?? "");
        setVariantInput(data.shopifyVariantId ?? "");
        setIsEditingMentor(false);
      } else if (res.status === 404) {
        setMessage("Program not found.");
      } else {
        setMessage("Failed to load program.");
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (ready) fetchProgram();
  }, [ready, fetchProgram]);

  // Lead-mentor picker searches adult members.
  const searchAdults = useCallback(async (query: string): Promise<ParticipantOption[]> => {
    const res = await fetch(`/api/people/search?q=${encodeURIComponent(query)}&filter=adults`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.people || [];
  }, []);

  const handleSaveGeneral = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveError("");
    try {
      const res = await fetch(`/api/programs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startAt: startAt || null,
          endAt: endAt || null,
          minAge: minAge ? parseInt(minAge) : null,
          maxAge: maxAge ? parseInt(maxAge) : null,
          maxParticipants: maxParticipants ? parseInt(maxParticipants) : null,
          phase, enrollmentStatus, orgMemberOnly, publiclyVisible: orgMemberOnly && publiclyVisible, announceOnOpen,
          leadMentorId: leadMentorIdInput ? parseInt(leadMentorIdInput) : null,
          memberPrice: memberPrice || null,
          nonMemberPrice: nonMemberPrice || null,
        })
      });
      if (res.ok) {
        notifications.show({ message: "Saved." });
        notifyNavRefresh();
        fetchProgram();
      } else {
        const data = await res.json().catch(() => ({}));
        setSaveError(data.error || "Failed to save settings.");
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveShopifyIds = async () => {
    setSyncing(true);
    try {
      const res = await fetch(`/api/programs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopifyProductId: shopifyProductIdInput || null,
          shopifyVariantId: variantInput || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notifications.show({ message: "Shopify identifiers saved." });
        notifyNavRefresh();
        fetchProgram();
      } else {
        notifications.show({ color: "red", message: data.error || "Failed to save.", autoClose: false });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setSyncing(false);
    }
  };

  const handleSyncShopify = async () => {
    setSyncing(true);
    try {
      const res = await fetch(`/api/programs/${id}/sync-shopify`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notifications.show({ message: "Shopify checkout configured." });
        notifyNavRefresh();
        fetchProgram();
      } else {
        notifications.show({ color: "red", message: data.error || "Failed to sync to Shopify.", autoClose: false });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setSyncing(false);
    }
  };

  if (loading || authLoading) {
    return <PageLoader />;
  }

  if (!ready) return null;

  if (!program) return (
    <Container size="sm" py="xl">
      <Card withBorder radius="md" padding="xl" ta="center">
        <Title order={3}>{message || "Not Found"}</Title>
        <Group justify="center" mt="lg"><Button onClick={() => router.push('/program-ops/programs')}>Back</Button></Group>
      </Card>
    </Container>
  );

  // Ownership gate stays inline — it needs the loaded program (lead-mentor id)
  // to decide, which useRequireRole (a static role gate) can't express.
  const user = sessionUser as unknown as { id: number; isSysadmin?: boolean; isBoardMember?: boolean };
  const isAuthorized = program.leadMentorId === user?.id || user?.isSysadmin || user?.isBoardMember;

  if (!isAuthorized) {
    return (
      <Container size="sm" py="xl">
        <Card withBorder radius="md" padding="xl" ta="center">
          <Title order={3}>Forbidden: Not authorized to manage this program.</Title>
          <Group justify="center" mt="lg"><Button onClick={() => router.push('/program-ops/programs')}>Back</Button></Group>
        </Card>
      </Container>
    );
  }

  const isSysAdminOrBoard = user?.isSysadmin || user?.isBoardMember;
  const phaseBadge = PHASE_BADGE[program.phase];
  // Pricing is fixed at creation; derive rather than track as state.
  const isFree = program.orgMemberPriceCents === null && program.nonOrgMemberPriceCents === null;

  const downloadQr = () => {
    const url = `${window.location.origin}/programs/${program.id}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`;
    const link = document.createElement('a');
    link.href = qrUrl;
    link.download = `QR_${program.name.replace(/[^a-z0-9]/gi, '_')}.png`;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <Container size="lg" pb="md">
      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" align="center" wrap="wrap" mb="lg">
          <Group align="center" gap="sm">
            <Title order={1}>{program.name}</Title>
            {phaseBadge && <Badge color={phaseBadge.color} variant="light" size="lg">{phaseBadge.label}</Badge>}
          </Group>
          <Button variant="default" onClick={() => router.push('/program-ops/programs')}>← Back to Programs</Button>
        </Group>

        <AlertBanner message={message} tone="info" mb="lg" />

        <Tabs value={activeTab} onChange={(v) => setActiveTab((v as typeof activeTab) ?? 'general')}>
          <ScrollableTabsList mb="lg">
            <Tabs.Tab value="general">General</Tabs.Tab>
            <Tabs.Tab value="roster">Roster</Tabs.Tab>
            <Tabs.Tab value="events">Events</Tabs.Tab>
          </ScrollableTabsList>

          {/* GENERAL */}
          <Tabs.Panel value="general">
            <form onSubmit={handleSaveGeneral}>
              <Stack mb="lg">
                <Group wrap="wrap">
                  <Button type="button" variant="light" onClick={downloadQr}>📷 Download QR Code</Button>
                  <Button type="button" variant="default" onClick={() => window.open(`/programs/${program.id}`, '_blank')}>📄 Public Details Page</Button>
                </Group>

                <Card withBorder radius="md" padding="md">
                  <Group justify="space-around">
                    <Stack gap={0} align="center"><Text fz="xl" fw={700}>{program.participants?.length || 0} {program.maxParticipants != null ? `/ ${program.maxParticipants}` : ''}</Text><Text size="sm" c="dimmed">Participants Enrolled</Text></Stack>
                    <Divider orientation="vertical" />
                    <Stack gap={0} align="center"><Text fz="xl" fw={700}>{program.volunteers?.length || 0}</Text><Text size="sm" c="dimmed">Assigned Volunteers</Text></Stack>
                    <Divider orientation="vertical" />
                    <Stack gap={0} align="center"><Text fz="xl" fw={700}>{program.events?.length || 0}</Text><Text size="sm" c="dimmed">Scheduled Sessions</Text></Stack>
                  </Group>
                </Card>

                {isProgramCheckoutBroken(program) ? (
                  <Alert color="red" variant="light" title="⚠️ Broken checkout">
                    <Stack gap="xs" align="flex-start">
                      <Text size="sm">
                        This program has a price but no Shopify checkout variant — paid enrollment will not work
                        (parents can&apos;t pay and enrollments stay pending). This happens when a program is priced
                        after it was first created.
                      </Text>
                      {isSysAdminOrBoard && (
                        <Button color="red" variant="filled" size="xs" loading={syncing} onClick={handleSyncShopify}>
                          Sync to Shopify
                        </Button>
                      )}
                    </Stack>
                  </Alert>
                ) : program.shopifyProductId && (
                  <Alert variant="light">✓ Pre-configured for Shopify Checkout (Product ID: {program.shopifyProductId})</Alert>
                )}

                {isSysAdminOrBoard && (
                  <Card withBorder radius="md" padding="md">
                    <Text fw={500} mb={4}>Shopify Checkout Identifiers</Text>
                    <Text size="xs" c="dimmed" mb="sm">
                      Admin/Board only. A priced program needs its variant ID or paid enrollment can&apos;t check out.
                      One variant covers both tiers — member pricing is a discount code applied at checkout.
                      Set these manually here (e.g. local/testing where there is no live Shopify), or use “Sync to Shopify” above to create them.
                    </Text>
                    <SimpleGrid cols={{ base: 1, sm: 2 }}>
                      <TextInput label="Variant ID" value={variantInput} onChange={e => setVariantInput(e.currentTarget.value)} placeholder="e.g. 40123456789" />
                      <TextInput label="Product ID (optional)" value={shopifyProductIdInput} onChange={e => setShopifyProductIdInput(e.currentTarget.value)} placeholder="e.g. 80123456789" />
                    </SimpleGrid>
                    <Group mt="sm">
                      <Button type="button" variant="light" size="xs" loading={syncing} onClick={handleSaveShopifyIds}>
                        Save Shopify IDs
                      </Button>
                    </Group>
                  </Card>
                )}
              </Stack>

              <Stack>
                <Card withBorder radius="md" padding="md">
                  <Text fw={500} mb="sm">Lead Mentor / Program Coordinator</Text>
                  {isSysAdminOrBoard ? (
                    program.leadMentor && !isEditingMentor ? (
                      <Group>
                        <Text c="green">{mentorLabel(program.leadMentor.name, program.leadMentor.email)}</Text>
                        <Button size="xs" fz={15} variant="default" type="button" onClick={() => { setIsEditingMentor(true); setMentorSearch(""); setLeadMentorIdInput(""); }}>Change</Button>
                      </Group>
                    ) : (
                      <Group gap="sm" align="flex-start" wrap="nowrap">
                        <Box style={{ flex: 1 }}>
                          <EntityPicker<ParticipantOption>
                            placeholder="Search Adult Members..."
                            selectedId={leadMentorIdInput || null}
                            selectedLabel={mentorSearch}
                            search={searchAdults}
                            getOptionLabel={(p) => p.name || 'Unnamed'}
                            getOptionDescription={(p) => p.email}
                            onSelect={(p) => { setLeadMentorIdInput(p.id.toString()); setMentorSearch(mentorLabel(p.name, p.email)); }}
                            onClear={() => { setLeadMentorIdInput(""); setMentorSearch(""); }}
                          />
                        </Box>
                        {program.leadMentor && (
                          <Button size="xs" fz={15} variant="subtle" color="red" type="button" onClick={() => { setIsEditingMentor(false); setLeadMentorIdInput(String(program.leadMentorId)); setMentorSearch(program.leadMentor ? mentorLabel(program.leadMentor.name, program.leadMentor.email) : ''); }}>Cancel</Button>
                        )}
                      </Group>
                    )
                  ) : (
                    program.leadMentor ? <Text c="green">{mentorLabel(program.leadMentor.name, program.leadMentor.email)}</Text> : <Text c="dimmed">No Lead Mentor Assigned</Text>
                  )}
                  <Text size="xs" c={isSysAdminOrBoard ? 'yellow' : 'dimmed'} mt="xs">
                    {isSysAdminOrBoard ? '*You have permission to reassign this program.' : '*Only Administrators/Board Members can change the Lead Mentor.'}
                  </Text>
                </Card>

                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput type="date" label="Start Date" value={startAt} onChange={e => setStartAt(e.currentTarget.value)} />
                  <TextInput type="date" label="End Date" value={endAt} onChange={e => setEndAt(e.currentTarget.value)} />
                  <NumberInput label="Minimum Age (Optional)" value={minAge} onChange={v => setMinAge(String(v))} min={0} max={25} placeholder="e.g. 14" />
                  <NumberInput label="Maximum Age (Optional)" value={maxAge} onChange={v => setMaxAge(String(v))} min={0} max={25} placeholder="e.g. 18" />
                </SimpleGrid>

                <div>
                  <NumberInput label="Max Participants (Optional)" value={maxParticipants} onChange={v => setMaxParticipants(String(v))} min={1} placeholder="Leave blank for unlimited" description="Sets the inventory limit on Shopify. Leave blank for unlimited enrollment." />
                  {(memberPrice || nonMemberPrice) && !maxParticipants && (
                    <Alert color="yellow" variant="light" mt="xs">⚠️ No max participants set — Shopify will allow unlimited purchases for this program.</Alert>
                  )}
                </div>

                <Checkbox checked={isFree} disabled label="This is a free program (Pricing cannot be changed)" />

                {!isFree && (
                  <SimpleGrid cols={{ base: 1, sm: orgMemberOnly ? 1 : 2 }}>
                    <NumberInput label="Treehouse Member Price ($)" value={memberPrice} disabled />
                    {!orgMemberOnly && <NumberInput label="Non-Member Price ($)" value={nonMemberPrice} disabled />}
                  </SimpleGrid>
                )}

                <Checkbox checked={orgMemberOnly} onChange={e => setMemberOnly(e.currentTarget.checked)} label="Treehouse Members-Only Program" />

                {orgMemberOnly && (
                  <Checkbox
                    ml="lg"
                    checked={publiclyVisible}
                    onChange={e => setPubliclyVisible(e.currentTarget.checked)}
                    label="Show to non-members"
                    description="List this members-only program publicly so non-members can see it. They still must be a member to enroll."
                  />
                )}

                <Checkbox
                  checked={announceOnOpen}
                  onChange={e => setAnnounceOnOpen(e.currentTarget.checked)}
                  label="Announce to members when enrollment opens"
                  description="Off by default. When on, reaching Upcoming + Open emails members whose membership covers this program's dates (once)."
                />

                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <Select label="Program Phase" value={phase} onChange={v => setPhase(v ?? 'PLANNING')} allowDeselect={false}
                    data={[
                      { value: 'PLANNING', label: 'Planning (Draft)' },
                      { value: 'UPCOMING', label: 'Upcoming (Published)' },
                      { value: 'RUNNING', label: 'Currently Running' },
                      { value: 'FINISHED', label: 'Finished' },
                    ]} />
                  <Select label="Enrollment Status" value={enrollmentStatus} onChange={v => setEnrollmentStatus(v ?? 'CLOSED')} allowDeselect={false}
                    data={[
                      { value: 'OPEN', label: 'Open for Enrollment' },
                      { value: 'CLOSED', label: 'Closed for Enrollment (Full / Stopped)' },
                    ]} />
                </SimpleGrid>

                {saveError && <Alert color="red" variant="light">{saveError}</Alert>}
                <Group gap="sm">
                  <Button type="submit" disabled={saving || !leadMentorIdInput} loading={saving}>
                    Save Settings
                  </Button>
                </Group>
              </Stack>
            </form>
          </Tabs.Panel>

          {/* ROSTER */}
          <Tabs.Panel value="roster">
            <ProgramRosterTab
              programId={id}
              program={program}
              isSysAdminOrBoard={!!isSysAdminOrBoard}
              fetchProgram={fetchProgram}
            />
          </Tabs.Panel>

          {/* EVENTS */}
          <Tabs.Panel value="events">
            <ProgramEventsTab programId={program.id} events={program.events} />
          </Tabs.Panel>
        </Tabs>
      </Card>
    </Container>
  );
}
