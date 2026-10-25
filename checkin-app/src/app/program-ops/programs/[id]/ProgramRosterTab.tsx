"use client";

import { useCallback, useState } from 'react';
import { Alert, Badge, Box, Button, Card, Checkbox, Group, Modal, SimpleGrid, Stack, Text, Textarea, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { EntityPicker } from '@/components/admin/EntityPicker';
import { useOrgTime } from '@/components/TimezoneProvider';
import { formatPhone } from '@/lib/phone';
import type { ProgramDetail, EligibleOption } from './page';

type Participant = ProgramDetail['participants'][number];

// Roster mutation routes answer with these advisory fields. A non-JSON body
// (session-expiry HTML redirect, proxy error page) must not throw and skip the
// roster refetch, so parse failures degrade to an empty object.
type ApiFeedback = { notice?: string; warning?: string; error?: string };
async function readJson(res: Response): Promise<ApiFeedback> {
  try { return await res.json(); } catch { return {}; }
}

// The household's leads, minus the participant themselves when they lead their
// own household — an adult enrolled in a program is not their own parent.
function parentsOf(p: Participant) {
  return (p.person.household?.householdMembers ?? []).filter(m => m.id !== p.personId);
}

// Contact fields are absent for a viewer the stripper denied them to, so a
// parent can legitimately render as a bare name.
function formatParent(m: ReturnType<typeof parentsOf>[number]) {
  const contact = [m.phone ? formatPhone(m.phone) : null, m.email || null].filter(Boolean).join(', ');
  return contact ? `${m.name || 'Unnamed'} - ${contact}` : (m.name || 'Unnamed');
}

type ProgramRosterTabProps = {
  programId: string;
  program: Pick<ProgramDetail, 'volunteers' | 'participants' | 'startAt' | 'minAge' | 'maxAge' | 'orgMemberPriceCents' | 'nonOrgMemberPriceCents'>;
  isSysAdminOrBoard: boolean;
  isBoardMember: boolean;
  fetchProgram: () => Promise<void>;
};

export function ProgramRosterTab({ programId, program, isSysAdminOrBoard, isBoardMember, fetchProgram }: ProgramRosterTabProps) {
  const { formatDateTime } = useOrgTime();
  const [saving, setSaving] = useState(false);
  const [enrollError, setEnrollError] = useState("");
  const [newVolId, setNewVolId] = useState("");
  const [volLabel, setVolLabel] = useState("");
  const [newPartId, setNewPartId] = useState("");
  const [partLabel, setPartLabel] = useState("");
  const [confirmRemoveVolOpened, { open: openConfirmRemoveVol, close: closeConfirmRemoveVol }] = useDisclosure(false);
  const [pendingRemoveVolId, setPendingRemoveVolId] = useState<number | null>(null);
  const [confirmAddPartOpened, { open: openConfirmAddPart, close: closeConfirmAddPart }] = useDisclosure(false);
  const [confirmRemovePartOpened, { open: openConfirmRemovePart, close: closeConfirmRemovePart }] = useDisclosure(false);
  const [pendingRemovePart, setPendingRemovePart] = useState<Participant | null>(null);
  const [pendingRemoveNeedsReason, setPendingRemoveNeedsReason] = useState(false);
  const [removeReason, setRemoveReason] = useState("");

  const sortedVolunteers = program.volunteers ? [...program.volunteers].sort((a, b) => (b.isCore ? 1 : 0) - (a.isCore ? 1 : 0)) : [];
  const activeParticipants = program.participants.filter(p => p.status === 'ACTIVE');
  const pendingParticipants = program.participants.filter(p => p.status === 'PENDING');
  // An active place on a priced program is paid: only the Board removes it, with a reason.
  // The roster carries no payment fields, so the Board gives a reason for every active
  // place; one paid before the price was zeroed is refused for others by the server.
  const isPriced = (program.orgMemberPriceCents ?? 0) > 0 || (program.nonOrgMemberPriceCents ?? 0) > 0;

  // Roster mutations must never fail silently: a rejected remove (403 from a
  // caller who isn't this program's lead, a 400, a 500) is otherwise
  // indistinguishable from a successful one — the row just stays put.
  const mutate = async (path: string, init: RequestInit): Promise<ApiFeedback | null> => {
    try {
      const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
      const data = await readJson(res);
      if (res.ok) return data;
      notifications.show({ color: 'red', message: data.error || `Request failed (${res.status}).`, autoClose: 6000 });
    } catch {
      notifications.show({ color: 'red', message: 'Network error — please try again.', autoClose: 6000 });
    }
    return null;
  };

  // Volunteer + participant pickers both search this program's eligible members.
  const searchEligible = useCallback(async (query: string): Promise<EligibleOption[]> => {
    const res = await fetch(`/api/programs/${programId}/eligible-participants?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.members || [];
  }, [programId]);

  const handleAddVolunteer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVolId) return;
    setSaving(true);
    try {
      const ok = await mutate(`/api/programs/${programId}/volunteers`, {
        method: 'POST',
        body: JSON.stringify({ participantId: parseInt(newVolId) })
      });
      if (ok) { setNewVolId(""); setVolLabel(""); fetchProgram(); }
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveVolunteer = (participantId: number) => {
    setPendingRemoveVolId(participantId);
    openConfirmRemoveVol();
  };

  const confirmRemoveVolunteer = async () => {
    if (pendingRemoveVolId === null) return;
    closeConfirmRemoveVol();
    const participantId = pendingRemoveVolId;
    setPendingRemoveVolId(null);
    const ok = await mutate(`/api/programs/${programId}/volunteers`, { method: 'DELETE', body: JSON.stringify({ participantId }) });
    if (ok) fetchProgram();
  };

  const handleToggleCore = async (participantId: number, isCore: boolean) => {
    setSaving(true);
    try {
      const ok = await mutate(`/api/programs/${programId}/volunteers`, { method: 'PATCH', body: JSON.stringify({ participantId, isCore }) });
      if (ok) fetchProgram();
    } finally {
      setSaving(false);
    }
  };

  const handleAddParticipant = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPartId) return;

    if (isSysAdminOrBoard) {
      openConfirmAddPart();
      return;
    }

    doAddParticipant();
  };

  const doAddParticipant = async () => {
    closeConfirmAddPart();
    setSaving(true);
    setEnrollError("");
    try {
      const res = await fetch(`/api/programs/${programId}/participants`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantId: parseInt(newPartId), override: true })
      });
      const data = await readJson(res);
      if (res.ok) {
        if (data.warning) notifications.show({ color: 'yellow', message: data.warning, autoClose: false });
        setNewPartId(""); setPartLabel(""); fetchProgram();
      }
      else {
        if (res.status === 409) {
          // Race: benign double-submit / stale view — already enrolled.
          notifications.show({ color: "red", message: data.error || "Participant is already enrolled in this program.", autoClose: 4000 });
          setNewPartId(""); setPartLabel("");
          fetchProgram();
        } else {
          setEnrollError(data.error || "Failed to enroll participant.");
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveParticipant = (p: Participant, needsReason = false) => {
    setPendingRemovePart(p);
    setPendingRemoveNeedsReason(needsReason);
    setRemoveReason("");
    openConfirmRemovePart();
  };

  // "remove" deletes a place nobody took up; "withdraw" keeps it as history.
  const confirmRemoveParticipant = async (mode: 'remove' | 'withdraw') => {
    if (pendingRemovePart === null) return;
    closeConfirmRemovePart();
    const participantId = pendingRemovePart.personId;
    const reason = removeReason.trim();
    setPendingRemovePart(null);
    const body = pendingRemoveNeedsReason ? { participantId, mode, reason } : { participantId, mode };
    const data = await mutate(`/api/programs/${programId}/participants`, { method: 'DELETE', body: JSON.stringify(body) });
    if (data) {
      if (data.notice) notifications.show({ color: 'blue', message: data.notice, autoClose: false });
      if (data.warning) notifications.show({ color: 'yellow', message: data.warning, autoClose: false });
      fetchProgram();
    }
  };

  return (
    <Stack gap="xl">
      {/* Volunteers */}
      <Card withBorder radius="md" padding="lg">
        <Title order={4} mb="md">Volunteers ({program.volunteers.length})</Title>
        <form onSubmit={handleAddVolunteer}>
          <Group align="flex-end" gap="md" mb="lg" wrap="wrap">
            <Box style={{ flex: 1, minWidth: 200 }}>
              <EntityPicker<EligibleOption>
                label="Assign Volunteer"
                placeholder="Start typing to search..."
                selectedId={newVolId || null}
                selectedLabel={volLabel}
                search={searchEligible}
                getOptionLabel={(p) => p.name || 'Unnamed'}
                onSelect={(p) => { setNewVolId(p.id.toString()); setVolLabel(p.name || 'Unnamed'); }}
                onClear={() => { setNewVolId(""); setVolLabel(""); }}
              />
            </Box>
            <Button type="submit" disabled={saving || !newVolId}>Add</Button>
          </Group>
        </form>

        {program.volunteers.length === 0 ? <Text c="dimmed">No volunteers assigned.</Text> : (
          <Stack gap="xs">
            {sortedVolunteers.map(v => (
              <Group key={v.personId} justify="space-between" p="sm" style={{ borderRadius: 6, background: 'var(--mantine-color-default-hover)' }}>
                <Group gap="md" wrap="wrap">
                  <Text fw={500}>{v.person.name || 'Unnamed'} <Text component="span" c="dimmed" size="sm">({v.person.email})</Text></Text>
                  <Checkbox size="xs" checked={v.isCore} disabled={saving} onChange={e => handleToggleCore(v.personId, e.currentTarget.checked)}
                    label={<Text size="sm" c={v.isCore ? 'yellow' : undefined}>Core Volunteer</Text>} />
                </Group>
                <Button size="compact-xs" variant="subtle" color="red" onClick={() => handleRemoveVolunteer(v.personId)}>Remove</Button>
              </Group>
            ))}
          </Stack>
        )}
      </Card>

      {/* Active Participants */}
      <Card withBorder radius="md" padding="lg">
        <Title order={4} mb="md">Active Participants ({activeParticipants.length})</Title>
        <form onSubmit={handleAddParticipant}>
          <Group align="flex-end" gap="md" mb="lg" wrap="wrap">
            <Box style={{ flex: 1, minWidth: 200 }}>
              <EntityPicker<EligibleOption>
                label="Assign Participant"
                placeholder="Start typing to search..."
                selectedId={newPartId || null}
                selectedLabel={partLabel}
                search={searchEligible}
                getOptionLabel={(p) => p.name || 'Unnamed'}
                getOptionDescription={(p) => p.ageWarning && <Badge color="yellow" variant="light">⚠️ {p.ageWarning}</Badge>}
                onSelect={(p) => { setNewPartId(p.id.toString()); setPartLabel(p.name || 'Unnamed'); }}
                onClear={() => { setNewPartId(""); setPartLabel(""); }}
              />
            </Box>
            {!isSysAdminOrBoard ? (
              <Alert color="yellow" variant="light" style={{ flex: 1 }}>
                ⚠️ Program Leads cannot manually enroll participants. Participants must enroll themselves and complete payment via Shopify.
              </Alert>
            ) : (
              <Button type="submit" disabled={saving || !newPartId}>Enroll</Button>
            )}
          </Group>
        </form>

        {enrollError && <Alert color="red" variant="light" mb="lg">{enrollError}</Alert>}

        {activeParticipants.length === 0 ? <Text c="dimmed">No active participants yet.</Text> : (
          <Stack gap="xs">
            {activeParticipants.map(p => {
              const parents = parentsOf(p);
              return (
              <Card key={p.personId} withBorder radius="sm" padding="sm">
                <Group justify="space-between">
                  <Text fw={700} c="blue">{p.person.name || 'Unnamed'}</Text>
                  {isPriced && !isBoardMember ? (
                    <Button size="compact-xs" variant="subtle" color="red" disabled title="Only the Board removes a paid place">Remove</Button>
                  ) : (
                    <Button size="compact-xs" variant="subtle" color="red" onClick={() => handleRemoveParticipant(p, isBoardMember)}>Remove</Button>
                  )}
                </Group>
                <SimpleGrid cols={{ base: 1, sm: 2 }} mt="xs" spacing="xs">
                  <Text size="sm" c="dimmed"><strong>Email:</strong> {p.person.email}</Text>
                  {p.person.household && (
                    <>
                      <Text size="sm" c="dimmed" style={{ gridColumn: '1 / -1' }}>
                        <strong>Parent/Guardian:</strong>{' '}
                        {parents.length > 0 ? parents.map(formatParent).join('; ') : 'N/A'}
                      </Text>
                      <Text size="sm" c="dimmed" style={{ gridColumn: '1 / -1' }}>
                        <strong>Emergency Contact{(p.person.household.emergencyContacts?.length ?? 0) > 1 ? 's' : ''}:</strong>{' '}
                        {p.person.household.emergencyContacts && p.person.household.emergencyContacts.length > 0
                          ? p.person.household.emergencyContacts.map((c) => `${c.name} - ${formatPhone(c.phone)}`).join('; ')
                          : 'N/A'}
                      </Text>
                    </>
                  )}
                </SimpleGrid>
              </Card>
              );
            })}
          </Stack>
        )}
      </Card>

      {/* Pending Participants */}
      <Card withBorder radius="md" padding="lg">
        <Title order={4} mb="md">Pending Participants ({pendingParticipants.length})</Title>
        {pendingParticipants.length === 0 ? <Text c="dimmed">No pending participants.</Text> : (
          <Stack gap="xs">
            {pendingParticipants.map(p => (
              <Card key={p.personId} withBorder radius="sm" padding="sm">
                <Group justify="space-between">
                  <Text fw={700} c="yellow">{p.person.name || 'Unnamed'}</Text>
                  <Button size="compact-xs" variant="subtle" color="red" onClick={() => handleRemoveParticipant(p)}>Remove</Button>
                </Group>
                <SimpleGrid cols={{ base: 1, sm: 2 }} mt="xs" spacing="xs">
                  <Text size="sm" c="dimmed"><strong>Email:</strong> {p.person.email}</Text>
                  <Text size="sm" c="dimmed"><strong>Pending Since:</strong> {p.pendingSince ? formatDateTime(p.pendingSince) : 'Unknown'}</Text>
                </SimpleGrid>
              </Card>
            ))}
          </Stack>
        )}
      </Card>

      <Modal opened={confirmRemoveVolOpened} onClose={closeConfirmRemoveVol} title={<Text span fw={700} fz="lg">Remove Volunteer</Text>} centered>
        <Text mb="lg">Remove this volunteer?</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeConfirmRemoveVol}>Cancel</Button>
          <Button color="red" onClick={confirmRemoveVolunteer}>Remove</Button>
        </Group>
      </Modal>

      <Modal opened={confirmAddPartOpened} onClose={closeConfirmAddPart} title={<Text span fw={700} fz="lg">Add Participant Manually</Text>} centered>
        <Text mb="lg">Warning: Adding a participant manually bypasses all payment requirements. Are you sure you wish to proceed?</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeConfirmAddPart}>Cancel</Button>
          <Button color="red" onClick={doAddParticipant} disabled={saving} loading={saving}>Add Participant</Button>
        </Group>
      </Modal>

      <Modal opened={confirmRemovePartOpened} onClose={closeConfirmRemovePart} title={<Text span fw={700} fz="lg">Remove Participant</Text>} centered>
        <Text mb="lg">Did this participant take part? A withdrawal keeps their enrollment as history; removing deletes it as if they never enrolled.</Text>
        {pendingRemoveNeedsReason && (
          <Textarea
            mb="lg"
            required
            label="Reason"
            description="A paid place needs the Board's written reason. It is kept in the audit log."
            value={removeReason}
            onChange={e => setRemoveReason(e.currentTarget.value)}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={closeConfirmRemovePart}>Cancel</Button>
          <Button color="red" variant={pendingRemovePart?.status === 'ACTIVE' ? 'light' : 'filled'} disabled={pendingRemoveNeedsReason && !removeReason.trim()} onClick={() => confirmRemoveParticipant('remove')}>Never took part: remove</Button>
          <Button color="red" variant={pendingRemovePart?.status === 'ACTIVE' ? 'filled' : 'light'} disabled={pendingRemoveNeedsReason && !removeReason.trim()} onClick={() => confirmRemoveParticipant('withdraw')}>Withdrew: keep history</Button>
        </Group>
      </Modal>
    </Stack>
  );
}
