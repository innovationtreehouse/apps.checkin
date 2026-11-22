"use client";

import { useState, useMemo, useRef } from 'react';
import { Button, Center, Group, Loader, Modal, Select, Stack, Switch, Table, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconChevronDown, IconChevronUp, IconDeviceLaptop, IconLock, IconRobot, IconScan, IconSelector, IconUserCheck } from '@tabler/icons-react';
import { useRequireRole } from '@/hooks/useRequireRole';
import { FACILITY_RECORD_ROLES } from '@/lib/nav/sections/facilityOps';
import { errorMessage, LoadError, showError, showSuccess } from '@checkin/component-ui';
import { api, useLoad } from '@/lib/api';
import { toDatetimeLocal, fromDatetimeLocal } from '@/lib/time';
import { useOrgTime } from '@/components/TimezoneProvider';
import { MAX_VISIT_MS } from '@/lib/visitTimes';

import { PageLoader } from "@/components/ui/PageLoader";
type VisitSource = 'SCANNER' | 'WEB' | 'TYPED' | 'LEAD_MARKED' | 'FACILITY_CLOSE' | 'AUTO_CLOSE';

type Visit = {
  id: number;
  arrivedAt: string | null;
  departedAt?: string | null;
  arrivedVia?: VisitSource | null;
  departedVia?: VisitSource | null;
  facilityCloseId?: number | null;
  facilityClose?: { closedBy?: { name?: string | null } | null } | null;
  person?: { name?: string | null; email?: string | null } | null;
  event?: { name?: string | null } | null;
  deletedAt?: string | null;
  deletedById?: number | null;
};

type RemovedAnswer = { visits: { Visit: Visit[]; Person: { id: number; name: string }[] } };

const SOURCE_META: Record<VisitSource, { Icon: typeof IconScan; label: string }> = {
  SCANNER: { Icon: IconScan, label: 'Scanner (kiosk badge)' },
  WEB: { Icon: IconDeviceLaptop, label: 'Web (legacy typed form)' },
  TYPED: { Icon: IconDeviceLaptop, label: 'Typed (form clock, not a badge)' },
  LEAD_MARKED: { Icon: IconUserCheck, label: 'Marked present by staff (event window, not measured)' },
  FACILITY_CLOSE: { Icon: IconLock, label: 'Building closed (stamped at the close moment)' },
  AUTO_CLOSE: { Icon: IconRobot, label: 'Nightly sweep (stamped at cron-run time — likely late)' },
};

const SourceIcon = ({ via }: { via?: VisitSource | null }) => {
  if (!via) return null;
  const { Icon, label } = SOURCE_META[via];
  return (
    <Tooltip label={label} withArrow>
      <Icon size={14} stroke={1.5} style={{ verticalAlign: 'middle', color: 'var(--mantine-color-dimmed)' }} />
    </Tooltip>
  );
};

// What is wrong with a departure given its arrival, or undefined when either is blank or the pair is fine.
const departureError = (arrivedAt: string, departedAt: string) => {
  if (!arrivedAt || !departedAt) return undefined;
  const span = Date.parse(departedAt) - Date.parse(arrivedAt);
  if (span <= 0) return 'Departure time must be after arrival time';
  if (span > MAX_VISIT_MS) return 'A visit cannot be longer than 24 hours.';
  return undefined;
};

type AddErrors = { personId?: string; arrivedAt?: string; departedAt?: string };

type SortKey = 'id' | 'participant' | 'event' | 'arrivedAt' | 'departedAt';

const sortValue = (v: Visit, key: SortKey): string | number => {
  switch (key) {
    case 'id': return v.id;
    case 'participant': return (v.person?.name || v.person?.email || '').toLowerCase();
    case 'event': return (v.event?.name || 'Open Facility').toLowerCase();
    case 'arrivedAt': return v.arrivedAt ? Date.parse(v.arrivedAt) : 0;
    case 'departedAt': return v.departedAt ? Date.parse(v.departedAt) : 0;
  }
};

type SortState = { key: SortKey; dir: 'asc' | 'desc' };

const SortableTh = ({ k, label, sort, onSort }: { k: SortKey; label: string; sort: SortState; onSort: (key: SortKey) => void }) => {
  const active = sort.key === k;
  const Icon = !active ? IconSelector : sort.dir === 'asc' ? IconChevronUp : IconChevronDown;
  return (
    <Table.Th>
      <UnstyledButton onClick={() => onSort(k)} style={{ font: 'inherit' }}>
        <Group gap={4} wrap="nowrap">
          <span>{label}</span>
          <Icon size={14} stroke={1.5} />
        </Group>
      </UnstyledButton>
    </Table.Th>
  );
};

export default function AdminVisitsPage() {
  const { formatDateTime } = useOrgTime();
  const { ready, loading: authLoading } = useRequireRole(FACILITY_RECORD_ROLES);


  const [editingVisitId, setEditingVisitId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ arrivedAt: "", departedAt: "" });
  // A departure the form itself rejects is flagged on the edited row's input; the row stays in edit mode.
  const [editDepartedError, setEditDepartedError] = useState<string | undefined>();
  const editDepartedRef = useRef<HTMLInputElement>(null);

  // Insert-for-others: the walk-in path neither the kiosk (live only) nor the
  // event roster mark (program-scoped, event window) can record.
  const [addOpened, { open: openAdd, close: closeAdd }] = useDisclosure(false);
  const [addForm, setAddForm] = useState({ personId: '', arrivedAt: '', departedAt: '' });
  const [addErrors, setAddErrors] = useState<AddErrors>({});
  const addPersonRef = useRef<HTMLInputElement>(null);
  const addArrivedRef = useRef<HTMLInputElement>(null);
  const addDepartedRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);

  const [closedOut, setClosedOut] = useState(false);
  const { data, error, reload } = useLoad<{ visits: Visit[] }>(
    ready ? (closedOut ? '/api/facility/visits?closedOut=true' : '/api/facility/visits') : null,
  );
  const [showRemoved, setShowRemoved] = useState(false);
  // No standing close ends a removed visit, so the closed-out view never lists one.
  const listRemoved = showRemoved && !closedOut;
  const { data: removedData, error: removedError, reload: reloadRemoved } = useLoad<RemovedAnswer>(
    ready && listRemoved ? '/api/facility/visits?removed=true' : null,
  );
  const removerNames = useMemo(
    () => new Map((removedData?.visits.Person ?? []).map((p) => [p.id, p.name])),
    [removedData],
  );
  const visits = useMemo(
    () => [...(data?.visits ?? []), ...(listRemoved ? removedData?.visits.Visit ?? [] : [])],
    [data, removedData, listRemoved],
  );
  const { data: peopleAnswer, error: peopleError, reload: reloadPeople } = useLoad<{ people?: { id: number; name: string | null; email: string }[] }>(
    addOpened ? '/api/people/search' : null,
  );
  const people = peopleAnswer?.people ?? [];
  const [sort, setSort] = useState<SortState>({ key: 'arrivedAt', dir: 'desc' });
  const [searchTerm, setSearchTerm] = useState('');
  const [confirmEditOpened, { open: openConfirmEdit, close: closeConfirmEdit }] = useDisclosure(false);
  const [pendingEditVisit, setPendingEditVisit] = useState<Visit | null>(null);
  const [confirmDeleteOpened, { open: openConfirmDelete, close: closeConfirmDelete }] = useDisclosure(false);
  const [pendingDeleteVisit, setPendingDeleteVisit] = useState<Visit | null>(null);

  const sortedVisits = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const matching = term
      ? visits.filter((v) =>
          [v.id, v.person?.name, v.person?.email, v.event?.name || 'Open Facility'].some((f) =>
            String(f ?? '').toLowerCase().includes(term),
          ),
        )
      : visits;
    // The server sends the closed-out list grouped by close.
    if (closedOut) return matching;
    return [...matching].sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [visits, sort, searchTerm, closedOut]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });

  // The Select is searchable over the whole directory the search endpoint returns.
  const openAddModal = () => {
    setAddErrors({});
    setAddForm({ personId: '', arrivedAt: '', departedAt: '' });
    openAdd();
  };

  const handleAdd = async () => {
    // Instant feedback only — server remains the trust boundary.
    const errors: AddErrors = {
      personId: addForm.personId ? undefined : 'Choose a person.',
      arrivedAt: addForm.arrivedAt ? undefined : 'Arrival time is required.',
      departedAt: addForm.departedAt ? departureError(addForm.arrivedAt, addForm.departedAt) : 'Departure time is required.',
    };
    setAddErrors(errors);
    const firstBroken = errors.personId ? addPersonRef : errors.arrivedAt ? addArrivedRef : errors.departedAt ? addDepartedRef : null;
    if (firstBroken) {
      firstBroken.current?.focus();
      return;
    }
    setAdding(true);
    try {
      await api('/api/facility/visits/insert', {
        method: 'POST',
        body: JSON.stringify({
          personId: Number(addForm.personId),
          arrivedAt: fromDatetimeLocal(addForm.arrivedAt),
          departedAt: fromDatetimeLocal(addForm.departedAt),
        }),
      });
      showSuccess('Visit added.');
      closeAdd();
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setAdding(false);
    }
  };

  const handleEditClick = (visit: Visit) => {
    setPendingEditVisit(visit);
    openConfirmEdit();
  };

  const confirmEditClick = () => {
    if (!pendingEditVisit) return;
    closeConfirmEdit();
    setEditDepartedError(undefined);
    setEditingVisitId(pendingEditVisit.id);
    setEditForm({
      arrivedAt: toDatetimeLocal(pendingEditVisit.arrivedAt),
      departedAt: toDatetimeLocal(pendingEditVisit.departedAt ?? null)
    });
    setPendingEditVisit(null);
  };

  const handleSaveEdit = async (id: number) => {
    // Instant feedback only — server remains the trust boundary.
    const departedError = editForm.departedAt
      ? departureError(editForm.arrivedAt, editForm.departedAt)
      : "Departure time is required to close this visit.";
    setEditDepartedError(departedError);
    if (departedError) {
      editDepartedRef.current?.focus();
      return;
    }
    try {
      await api(`/api/facility/visits`, {
        method: 'PATCH',
        body: JSON.stringify({
          visitId: id,
          arrivedAt: editForm.arrivedAt ? fromDatetimeLocal(editForm.arrivedAt) : undefined,
          departedAt: editForm.departedAt ? fromDatetimeLocal(editForm.departedAt) : undefined
        })
      });
      showSuccess("Visit updated successfully.");
      setEditingVisitId(null);
    } catch (e) {
      showError(errorMessage(e));
    }
  };

  const handleDeleteClick = (visit: Visit) => {
    setPendingDeleteVisit(visit);
    openConfirmDelete();
  };

  const confirmDeleteClick = async () => {
    if (!pendingDeleteVisit) return;
    const id = pendingDeleteVisit.id;
    closeConfirmDelete();
    setPendingDeleteVisit(null);
    try {
      await api(`/api/facility/visits`, { method: 'DELETE', body: JSON.stringify({ visitId: id }) });
      showSuccess("Visit deleted.");
    } catch (e) {
      showError(errorMessage(e));
    }
  };

  const handleRestore = async (id: number) => {
    try {
      await api('/api/facility/visits/restore', { method: 'POST', body: JSON.stringify({ visitId: id }) });
      showSuccess("Visit restored.");
    } catch (e) {
      showError(errorMessage(e));
    }
  };

  if (authLoading) {
    return <PageLoader />;
  }

  if (!ready) return null;

  return (
    <Stack>
      <Group justify="space-between">
        <TextInput
          placeholder="Filter by name, email, event, or ID..."
          style={{ flex: 1, minWidth: 200 }}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.currentTarget.value)}
        />
        <Switch
          label="Closed out by a close"
          checked={closedOut}
          onChange={(e) => setClosedOut(e.currentTarget.checked)}
        />
        <Switch
          label="Show removed"
          checked={showRemoved}
          disabled={closedOut}
          onChange={(e) => setShowRemoved(e.currentTarget.checked)}
        />
        <Button size="xs" fz={15} onClick={openAddModal}>Add Visit</Button>
      </Group>

      {error && <LoadError what="the visits" message={error} onRetry={reload} />}
      {listRemoved && removedError && <LoadError what="the removed visits" message={removedError} onRetry={reloadRemoved} />}
      {!data && !error && <Center py="xl"><Loader /></Center>}

      {data && <Table.ScrollContainer minWidth={800}>
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <SortableTh sort={sort} onSort={toggleSort} k="id" label="ID" />
              <SortableTh sort={sort} onSort={toggleSort} k="participant" label="Participant" />
              <SortableTh sort={sort} onSort={toggleSort} k="event" label="Event" />
              <SortableTh sort={sort} onSort={toggleSort} k="arrivedAt" label="Arrived" />
              <SortableTh sort={sort} onSort={toggleSort} k="departedAt" label="Departed" />
              {closedOut && <Table.Th>Close</Table.Th>}
              {listRemoved && <Table.Th>Removed</Table.Th>}
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sortedVisits.map((v) => (
              <Table.Tr key={v.id}>
                <Table.Td>{v.id}</Table.Td>
                <Table.Td>{v.person?.name || v.person?.email}</Table.Td>
                <Table.Td>{v.event?.name || 'Open Facility'}</Table.Td>

                {editingVisitId === v.id ? (
                  <>
                    <Table.Td>
                      <TextInput
                        type="datetime-local"
                        size="xs"
                        aria-label="Arrived"
                        value={editForm.arrivedAt}
                        onChange={(e) => { setEditForm({ ...editForm, arrivedAt: e.currentTarget.value }); setEditDepartedError(undefined); }}
                      />
                    </Table.Td>
                    <Table.Td>
                      <TextInput
                        ref={editDepartedRef}
                        type="datetime-local"
                        size="xs"
                        aria-label="Departed"
                        value={editForm.departedAt}
                        error={editDepartedError}
                        onChange={(e) => { setEditForm({ ...editForm, departedAt: e.currentTarget.value }); setEditDepartedError(undefined); }}
                      />
                    </Table.Td>
                    {closedOut && <Table.Td>#{v.facilityCloseId}</Table.Td>}
                    {listRemoved && <Table.Td />}
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Button size="xs" fz={15} onClick={() => handleSaveEdit(v.id)}>Save</Button>
                        <Button size="xs" fz={15} variant="default" onClick={() => setEditingVisitId(null)}>Cancel</Button>
                      </Group>
                    </Table.Td>
                  </>
                ) : (
                  <>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <span>{formatDateTime(v.arrivedAt)}</span>
                        <SourceIcon via={v.arrivedVia} />
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      {v.departedAt ? (
                        <Group gap={6} wrap="nowrap">
                          <span>{formatDateTime(v.departedAt)}</span>
                          <SourceIcon via={v.departedVia} />
                        </Group>
                      ) : <Text component="span" c="yellow">Active</Text>}
                    </Table.Td>
                    {closedOut && (
                      <Table.Td>{v.facilityCloseId ? <>#{v.facilityCloseId} · {v.departedVia === 'AUTO_CLOSE' ? 'Nightly' : (v.facilityClose?.closedBy?.name ?? 'Closer deleted')}</> : null}</Table.Td>
                    )}
                    {listRemoved && (
                      <Table.Td>
                        {v.deletedAt ? `${removerNames.get(v.deletedById ?? -1) ?? 'Unknown'} · ${formatDateTime(v.deletedAt)}` : null}
                      </Table.Td>
                    )}
                    <Table.Td>
                      {v.deletedAt ? (
                        <Button size="xs" fz={15} variant="light" onClick={() => handleRestore(v.id)}>Restore</Button>
                      ) : v.departedAt ? (
                        <Group gap="xs" wrap="nowrap">
                          <Button size="xs" fz={15} variant="light" onClick={() => handleEditClick(v)}>Edit</Button>
                          <Button size="xs" fz={15} variant="light" color="red" onClick={() => handleDeleteClick(v)}>Delete</Button>
                        </Group>
                      ) : <Text component="span" size="sm" c="dimmed">Still checked in: fix after they badge out or the 11 PM close</Text>}
                    </Table.Td>
                  </>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>}

      <Modal
        opened={addOpened}
        onClose={closeAdd}
        title={<Text span fw={700} fz="lg">Add Past Visit</Text>}
        centered
      >
        <Stack>
          <Text size="sm" c="dimmed">
            For a walk-in whose visit was never recorded. Closed visits only —
            live presence comes from the kiosk. This is logged to the audit trail.
          </Text>
          {peopleError && <LoadError what="the people list" message={peopleError} onRetry={reloadPeople} />}
          <Select
            label="Person"
            searchable
            data={people.map((p) => ({ value: String(p.id), label: p.name || p.email }))}
            ref={addPersonRef}
            value={addForm.personId || null}
            error={addErrors.personId}
            onChange={(v) => { setAddForm({ ...addForm, personId: v ?? '' }); setAddErrors({ ...addErrors, personId: undefined }); }}
          />
          <TextInput
            ref={addArrivedRef}
            type="datetime-local"
            label="Arrived"
            value={addForm.arrivedAt}
            error={addErrors.arrivedAt}
            onChange={(e) => { setAddForm({ ...addForm, arrivedAt: e.currentTarget.value }); setAddErrors({ ...addErrors, arrivedAt: undefined, departedAt: undefined }); }}
          />
          <TextInput
            ref={addDepartedRef}
            type="datetime-local"
            label="Departed"
            value={addForm.departedAt}
            error={addErrors.departedAt}
            onChange={(e) => { setAddForm({ ...addForm, departedAt: e.currentTarget.value }); setAddErrors({ ...addErrors, departedAt: undefined }); }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={closeAdd}>Cancel</Button>
            <Button onClick={handleAdd} loading={adding}>Add Visit</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={confirmEditOpened}
        onClose={closeConfirmEdit}
        title={<Text span fw={700} fz="lg">Edit Past Visit Record</Text>}
        centered
      >
        <Text mb="lg">
          Warning: You are editing a past visit record using Admin overrides. This will be permanently logged.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeConfirmEdit}>Cancel</Button>
          <Button color="red" onClick={confirmEditClick}>Continue</Button>
        </Group>
      </Modal>

      <Modal
        opened={confirmDeleteOpened}
        onClose={closeConfirmDelete}
        title={<Text span fw={700} fz="lg">Delete Visit Record</Text>}
        centered
      >
        <Text mb="lg">
          Warning: You are permanently deleting a visit record using Admin overrides. This will be permanently logged.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeConfirmDelete}>Cancel</Button>
          <Button color="red" onClick={confirmDeleteClick}>Delete</Button>
        </Group>
      </Modal>
    </Stack>
  );
}
