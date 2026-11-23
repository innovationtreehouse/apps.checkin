"use client";

import { useState, useCallback } from 'react';
import { Alert, Box, Button, Card, Checkbox, Divider, Group, NumberInput, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { errorMessage, showError, showSuccess, showWarning } from '@checkin/component-ui';
import { shallowEqual } from '@/components/UnsavedChangesProvider';
import { useSeedForm } from '@/hooks/useSeedForm';
import { api } from '@/lib/api';
import { EntityPicker } from '@/components/admin/EntityPicker';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { membershipYearLabel } from '@/lib/programYear';
import { ProgramYearField, YearBoundaryError, formYearsTouched, type YearBoundary } from '../../ProgramYearField';
import { ProgramShopifySection } from './ProgramShopifySection';
import type { ProgramDetail, ParticipantOption } from './page';

function mentorLabel(name: string | null, email: string): string {
  const label = name || 'Unnamed';
  return email ? `${label} (${email})` : label;
}

export function ProgramGeneralTab({ programId, program, isBoardMember, isSysAdminOrBoard, yearBoundary, storeClosed, reload }: {
  programId: string;
  program: ProgramDetail;
  isBoardMember: boolean;
  isSysAdminOrBoard: boolean;
  yearBoundary: YearBoundary;
  storeClosed: boolean;
  reload: () => Promise<void>;
}) {
  // Form States
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [yearChoice, setYearChoice] = useState<number | null>(null);
  const [offSaleAt, setOffSaleAt] = useState("");
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

  // EntityPicker owns the transient query/results/loading; we keep only the selected id + its display label.
  const [mentorSearch, setMentorSearch] = useState("");
  const [isEditingMentor, setIsEditingMentor] = useState(false);

  const [saving, setSaving] = useState(false);

  // The form reseeds from a read only while it is unedited, so a late read never overwrites typing.
  const generalForm = { startAt, endAt, yearChoice, offSaleAt, minAge, maxAge, maxParticipants, phase, enrollmentStatus, orgMemberOnly, publiclyVisible, announceOnOpen, leadMentorIdInput };
  const [seededGeneral, setSeededGeneral] = useState<typeof generalForm | null>(null);

  useSeedForm(program, !!seededGeneral && !shallowEqual(seededGeneral, generalForm), (data) => {
    const form = {
      startAt: data.startAt.split('T')[0],
      endAt: data.endAt.split('T')[0],
      yearChoice: null,
      offSaleAt: data.offSaleAt ? data.offSaleAt.split('T')[0] : "",
      minAge: data.minAge !== null ? String(data.minAge) : "",
      maxAge: data.maxAge !== null ? String(data.maxAge) : "",
      maxParticipants: data.maxParticipants !== null ? String(data.maxParticipants) : "",
      phase: data.phase || "PLANNING",
      enrollmentStatus: data.enrollmentStatus || "CLOSED",
      orgMemberOnly: Boolean(data.orgMemberOnly),
      publiclyVisible: Boolean(data.publiclyVisible),
      announceOnOpen: Boolean(data.announceOnOpen),
      leadMentorIdInput: data.leadMentorId !== null ? String(data.leadMentorId) : "",
    };
    setStartAt(form.startAt);
    setEndAt(form.endAt);
    setYearChoice(form.yearChoice);
    setOffSaleAt(form.offSaleAt);
    setMinAge(form.minAge);
    setMaxAge(form.maxAge);
    setMaxParticipants(form.maxParticipants);
    setPhase(form.phase);
    setEnrollmentStatus(form.enrollmentStatus);
    setMemberOnly(form.orgMemberOnly);
    setPubliclyVisible(form.publiclyVisible);
    setAnnounceOnOpen(form.announceOnOpen);
    setLeadMentorIdInput(form.leadMentorIdInput);
    setSeededGeneral(form);
    setMemberPrice(data.orgMemberPriceCents !== null ? String(data.orgMemberPriceCents / 100) : "");
    setNonMemberPrice(data.nonOrgMemberPriceCents !== null ? String(data.nonOrgMemberPriceCents / 100) : "");
    setMentorSearch(data.leadMentor ? mentorLabel(data.leadMentor.name, data.leadMentor.email) : "");
    setIsEditingMentor(false);
  });

  // Lead-mentor picker searches adult members, judged for this program's membership year.
  const programYear = program.appliesToYear;
  const searchAdults = useCallback((query: string): Promise<ParticipantOption[]> =>
    api<{ people?: ParticipantOption[] }>(`/api/people/search?q=${encodeURIComponent(query)}&filter=adults${programYear ? `&year=${programYear}` : ''}`)
      .then((data) => data.people ?? [], () => []), [programYear]);

  const canStateYear = isBoardMember;
  const { boundary } = yearBoundary;
  const years = formYearsTouched(boundary, startAt, endAt);
  const crossing = years.length > 1;
  // A stored year counts as stated only when the saved dates cross; a derived year is never pre-selected.
  const statedYear = formYearsTouched(boundary, program.startAt.split('T')[0], program.endAt.split('T')[0]).length > 1
    ? program.appliesToYear : null;
  const candidateYear = yearChoice ?? statedYear;
  const effectiveYear = candidateYear != null && years.includes(candidateYear) ? candidateYear : null;

  const handleSaveGeneral = async (e: React.FormEvent) => {
    e.preventDefault();
    const statesYear = canStateYear && crossing;
    const paidPlaces = program.participants.filter((p) => p.status === 'ACTIVE').length;
    if (statesYear && statedYear != null && effectiveYear != null && effectiveYear !== statedYear && paidPlaces > 0
      && !window.confirm(`${paidPlaces} paid place${paidPlaces === 1 ? ' was' : 's were'} priced against ${membershipYearLabel(statedYear)}. Changing the membership year to ${membershipYearLabel(effectiveYear)} does not reprice them; the Board settles any difference with those families. Save anyway?`)) {
      return;
    }
    setSaving(true);
    try {
      const saved = await api<{ warning?: string; notice?: string }>(`/api/programs/${programId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          startAt: startAt || null,
          endAt: endAt || null,
          ...(statesYear && { appliesToYear: effectiveYear }),
          // Sent only when edited, so an untouched date keeps following the start date.
          ...(offSaleAt !== (program.offSaleAt?.split('T')[0] ?? "") && { offSaleAt: offSaleAt || null }),
          minAge: minAge ? parseInt(minAge) : null,
          maxAge: maxAge ? parseInt(maxAge) : null,
          maxParticipants: maxParticipants ? parseInt(maxParticipants) : null,
          phase, enrollmentStatus, orgMemberOnly, publiclyVisible: orgMemberOnly && publiclyVisible, announceOnOpen,
          leadMentorId: leadMentorIdInput ? parseInt(leadMentorIdInput) : null,
          memberPrice: memberPrice || null,
          nonMemberPrice: nonMemberPrice || null,
        })
      });
      const followUps = [saved?.warning, saved?.notice].filter((m): m is string => !!m);
      for (const message of followUps) showWarning(message);
      if (followUps.length === 0) showSuccess("Saved.");
      notifyNavRefresh();
      setSeededGeneral(generalForm);
      await reload();
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

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

        <ProgramShopifySection programId={programId} program={program} storeClosed={storeClosed} isSysAdminOrBoard={isSysAdminOrBoard} reload={reload} />
      </Stack>

      <Stack>
        <Card withBorder radius="md" padding="md">
          <Text fw={500} mb="sm">Program Leader</Text>
          {isBoardMember ? (
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
                    getOptionDisabledReason={(p) => p.id === program.leadMentorId ? null : p.leaderIneligibility ?? null}
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
            program.leadMentor ? <Text c="green">{mentorLabel(program.leadMentor.name, program.leadMentor.email)}</Text> : <Text c="dimmed">No Program Leader Assigned</Text>
          )}
          <Text size="xs" c={isBoardMember ? 'yellow' : 'dimmed'} mt="xs">
            {isBoardMember ? '*You have permission to reassign this program.' : '*Only the Board can change the Program Leader.'}
          </Text>
        </Card>

        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput type="date" label="Start Date" value={startAt} onChange={e => setStartAt(e.currentTarget.value)} />
          <TextInput type="date" label="End Date" value={endAt} onChange={e => setEndAt(e.currentTarget.value)} />
          <TextInput type="date" label="Off-Sale Date" value={offSaleAt} onChange={e => setOffSaleAt(e.currentTarget.value)} disabled={!isBoardMember} description="Enrollment closes and the store product comes off sale on this date. Blank = start date." />
          <NumberInput label="Minimum Age (Optional)" value={minAge} onChange={v => setMinAge(String(v))} min={0} max={25} placeholder="e.g. 14" />
          <NumberInput label="Maximum Age (Optional)" value={maxAge} onChange={v => setMaxAge(String(v))} min={0} max={25} placeholder="e.g. 18" />
        </SimpleGrid>

        <ProgramYearField years={years} value={effectiveYear} onChange={setYearChoice} canEdit={canStateYear} />
        <YearBoundaryError load={yearBoundary} />

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
          description="Off by default. When on, reaching Upcoming + Open emails members whose membership covers this program's membership year (once)."
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

        <Group gap="sm">
          <Button type="submit" disabled={saving || !leadMentorIdInput || (canStateYear && crossing && effectiveYear == null)} loading={saving}>
            Save Settings
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
