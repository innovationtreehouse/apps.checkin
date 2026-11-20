"use client";

import { useCallback, useState } from 'react';
import { ActionIcon, Alert, Badge, Box, Button, Card, Checkbox, Flex, Group, Menu, Modal, Radio, SimpleGrid, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import { useDisclosure } from '@mantine/hooks';
import { errorMessage, HttpError, showError, showWarning } from '@checkin/component-ui';
import { api } from '@/lib/api';
import { EntityPicker } from '@/components/admin/EntityPicker';
import { useOrgTime } from '@/components/TimezoneProvider';
import { formatPhone } from '@/lib/phone';
import type { ProgramDetail, EligibleOption } from './page';

type Participant = ProgramDetail['participants'][number];

// Roster mutation routes answer with these advisory fields.
type ApiFeedback = { notice?: string; warning?: string } | null;

// The household's leads, minus the participant themselves when they lead their
// own household — an adult enrolled in a program is not their own parent.
function parentsOf(p: Participant) {
  return (p.person.household?.householdMembers ?? []).filter(m => m.id !== p.personId);
}

function ageLabel(age: Participant['age']) {
  return age == null ? 'age unknown' : String(age);
}

// Contact fields are absent for a viewer the stripper denied them to, so a
// parent can legitimately render as a bare name.
function formatParent(m: ReturnType<typeof parentsOf>[number]) {
  const contact = [m.phone ? formatPhone(m.phone) : null, m.email || null].filter(Boolean).join(', ');
  return contact ? `${m.name || 'Unnamed'} - ${contact}` : (m.name || 'Unnamed');
}

// A row menu keeps Remove a deliberate second click away from the roster.
function RowActions({ name, onEnroll, onRemove }: { name: string; onEnroll?: () => void; onRemove?: () => void }) {
  if (!onEnroll && !onRemove) return null;
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray" aria-label={`Actions for ${name}`}>
          <IconDotsVertical size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {onEnroll && <Menu.Item onClick={onEnroll}>Enroll</Menu.Item>}
        {onRemove && <Menu.Item color="red" onClick={onRemove}>Remove</Menu.Item>}
      </Menu.Dropdown>
    </Menu>
  );
}

type Basis = 'OUTSIDE_PAYMENT' | 'MATCHED_ORDER' | 'COMP';
// Who the Enroll dialog is for: someone picked from the search, or an unpaid place on the roster.
type EnrollTarget = { personId: number; name: string };

type ProgramRosterTabProps = {
  programId: string;
  program: Pick<ProgramDetail, 'volunteers' | 'participants' | 'startAt' | 'minAge' | 'maxAge' | 'orgMemberPriceCents' | 'nonOrgMemberPriceCents'>;
  isSysAdminOrBoard: boolean;
  isBoardMember: boolean;
  /** Board or Finance: enrolls without a store payment, never in their own household. */
  canEnrollByHand: boolean;
  viewerHouseholdId: number | null;
  fetchProgram: () => Promise<void>;
};

export function ProgramRosterTab({ programId, program, isSysAdminOrBoard, isBoardMember, canEnrollByHand, viewerHouseholdId, fetchProgram }: ProgramRosterTabProps) {
  const { formatDateTime } = useOrgTime();
  const [saving, setSaving] = useState(false);
  const [newVolId, setNewVolId] = useState("");
  const [volLabel, setVolLabel] = useState("");
  const [newPartId, setNewPartId] = useState("");
  const [partLabel, setPartLabel] = useState("");
  const [confirmRemoveVolOpened, { open: openConfirmRemoveVol, close: closeConfirmRemoveVol }] = useDisclosure(false);
  const [pendingRemoveVolId, setPendingRemoveVolId] = useState<number | null>(null);
  const [enrollTarget, setEnrollTarget] = useState<EnrollTarget | null>(null);
  const [basis, setBasis] = useState<Basis | null>(null);
  const [orderId, setOrderId] = useState("");
  const [enrollNote, setEnrollNote] = useState("");
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
  // Only a Board member outside the household removes a paid place; nobody else is offered it.
  const outsideOwnHousehold = (p: Participant) => viewerHouseholdId == null || p.person.householdId !== viewerHouseholdId;
  const mayRemoveActive = (p: Participant) => !isPriced || (isBoardMember && outsideOwnHousehold(p));

  // A rejected roster change must say so: otherwise the row just stays put, as if it worked.
  const mutate = async (path: string, init: RequestInit): Promise<{ data: ApiFeedback } | null> => {
    try {
      return { data: await api<ApiFeedback>(path, init) };
    } catch (e) {
      showError(errorMessage(e));
      return null;
    }
  };

  // Volunteer + participant pickers both search this program's eligible members.
  const searchEligible = useCallback((query: string): Promise<EligibleOption[]> =>
    api<{ members?: EligibleOption[] }>(`/api/programs/${programId}/eligible-participants?q=${encodeURIComponent(query)}`)
      .then((data) => data.members ?? [], () => []), [programId]);

  const handleAddVolunteer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVolId) return;
    setSaving(true);
    try {
      const ok = await mutate(`/api/programs/${programId}/volunteers`, {
        method: 'POST',
        body: JSON.stringify({ participantId: parseInt(newVolId) })
      });
      if (ok) { setNewVolId(""); setVolLabel(""); await fetchProgram(); }
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
    if (ok) await fetchProgram();
  };

  const handleToggleCore = async (participantId: number, isCore: boolean) => {
    setSaving(true);
    try {
      const ok = await mutate(`/api/programs/${programId}/volunteers`, { method: 'PATCH', body: JSON.stringify({ participantId, isCore }) });
      if (ok) await fetchProgram();
    } finally {
      setSaving(false);
    }
  };

  const openEnroll = (target: EnrollTarget) => {
    setEnrollTarget(target);
    setBasis(null); setOrderId(""); setEnrollNote("");
  };

  // A free program has no payment to account for: staff add from the roster directly.
  const canAdd = isPriced ? canEnrollByHand : isSysAdminOrBoard;

  const handleAddParticipant = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPartId) return;
    if (isPriced) openEnroll({ personId: parseInt(newPartId), name: partLabel });
    else enroll(parseInt(newPartId), { override: true });
  };

  const doEnroll = () => {
    if (!enrollTarget || !basis) return;
    enroll(enrollTarget.personId, {
      basis,
      ...(basis === 'MATCHED_ORDER' && { shopifyOrderId: orderId.trim() }),
      ...(enrollNote.trim() && { note: enrollNote.trim() }),
      // The Board may also waive the program's limits (age, capacity, closed enrollment).
      ...(isBoardMember && { override: true }),
    });
  };

  const enroll = async (personId: number, fields: Record<string, unknown>) => {
    setSaving(true);
    try {
      const data = await api<ApiFeedback>(`/api/programs/${programId}/participants`, {
        method: 'POST',
        body: JSON.stringify({ participantId: personId, ...fields }),
      });
      if (data?.warning) showWarning(data.warning);
      setEnrollTarget(null);
      if (String(personId) === newPartId) { setNewPartId(""); setPartLabel(""); }
      await fetchProgram();
    } catch (e) {
      showError(errorMessage(e));
      // A 409 is a double submit or a stale view.
      if (e instanceof HttpError && e.status === 409) await fetchProgram();
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
    const result = await mutate(`/api/programs/${programId}/participants`, { method: 'DELETE', body: JSON.stringify(body) });
    if (result) {
      if (result.data?.notice) showWarning(result.data.notice);
      if (result.data?.warning) showWarning(result.data.warning);
      await fetchProgram();
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
          {/* On a phone the Program Lead notice stacks above the picker instead of squeezing beside it. */}
          <Flex
            direction={{ base: canAdd ? 'row' : 'column-reverse', sm: 'row' }}
            align={{ base: canAdd ? 'flex-end' : 'stretch', sm: 'flex-end' }}
            gap="md"
            mb="lg"
            wrap="wrap"
          >
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
            {!canAdd ? (
              <Alert color="yellow" variant="light" style={{ flex: 1 }}>
                ⚠️ Only the Board or Finance enroll participants here. Participants enroll themselves and pay via Shopify.
              </Alert>
            ) : (
              <Button type="submit" disabled={saving || !newPartId}>Enroll</Button>
            )}
          </Flex>
        </form>


        {activeParticipants.length === 0 ? <Text c="dimmed">No active participants yet.</Text> : (
          <Stack gap="xs">
            {activeParticipants.map(p => {
              const parents = parentsOf(p);
              return (
              <Card key={p.personId} withBorder radius="sm" padding="sm">
                <Group justify="space-between">
                  <Text fw={700} c="blue">{p.person.name || 'Unnamed'}{p.age !== undefined && <Text component="span" c="dimmed" size="sm"> ({ageLabel(p.age)})</Text>}</Text>
                  {mayRemoveActive(p) && <RowActions name={p.person.name || 'Unnamed'} onRemove={() => handleRemoveParticipant(p, isBoardMember)} />}
                </Group>
                <SimpleGrid cols={{ base: 1, sm: 2 }} mt="xs" spacing="xs">
                  <Text size="sm" c="dimmed"><strong>Email:</strong> {p.person.email}</Text>
                  {p.person.phone && <Text size="sm" c="dimmed"><strong>Phone:</strong> {formatPhone(p.person.phone)}</Text>}
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
                  <Text fw={700} c="yellow">{p.person.name || 'Unnamed'}{p.age !== undefined && <Text component="span" c="dimmed" size="sm"> ({ageLabel(p.age)})</Text>}</Text>
                  <RowActions
                    name={p.person.name || 'Unnamed'}
                    onEnroll={canEnrollByHand && outsideOwnHousehold(p) ? () => openEnroll({ personId: p.personId, name: p.person.name || 'Unnamed' }) : undefined}
                    // Finance enrolls here but does not remove places.
                    onRemove={canEnrollByHand && !isSysAdminOrBoard ? undefined : () => handleRemoveParticipant(p)}
                  />
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

      <Modal opened={enrollTarget !== null} onClose={() => setEnrollTarget(null)} title={<Text span fw={700} fz="lg">Enroll {enrollTarget?.name}</Text>} centered>
        <Stack>
          <Radio.Group label="What does this enrollment stand for?" value={basis} onChange={(v) => setBasis(v as Basis)} required>
            <Stack gap="xs" mt="xs">
              <Radio value="OUTSIDE_PAYMENT" label="Paid outside the store" description="A check or cash." />
              <Radio value="MATCHED_ORDER" label="Store order matched by hand" />
              <Radio value="COMP" label="No payment (comp)" />
            </Stack>
          </Radio.Group>
          {basis === 'MATCHED_ORDER' && (
            <TextInput
              required
              label="Store order id"
              description="The number at the end of the order's Shopify admin link."
              value={orderId}
              onChange={e => setOrderId(e.currentTarget.value)}
            />
          )}
          {basis === 'COMP' && (
            <Alert color="yellow" variant="light">This bypasses all payment.</Alert>
          )}
          <Textarea
            label="Note"
            description="Optional, such as a check number. It is kept in the audit log."
            value={enrollNote}
            onChange={e => setEnrollNote(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setEnrollTarget(null)}>Cancel</Button>
            <Button onClick={doEnroll} disabled={saving || !basis || (basis === 'MATCHED_ORDER' && !/^\d+$/.test(orderId.trim()))} loading={saving}>Enroll</Button>
          </Group>
        </Stack>
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
