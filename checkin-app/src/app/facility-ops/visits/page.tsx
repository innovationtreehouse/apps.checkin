"use client";

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, Table, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconChevronDown, IconChevronUp, IconDeviceLaptop, IconLock, IconRobot, IconScan, IconSelector, IconUserCheck } from '@tabler/icons-react';
import { useRequireRole } from '@/hooks/useRequireRole';
import { FACILITY_RECORD_ROLES } from '@/lib/facilityNav';
import { AlertBanner, type AlertTone } from '@/components/admin/AlertBanner';
import { notifications } from '@mantine/notifications';
import { toDatetimeLocal, fromDatetimeLocal } from '@/lib/time';
import { useOrgTime } from '@/components/TimezoneProvider';
import { MAX_VISIT_MS } from '@/lib/visitTimes';

import { PageLoader } from "@/components/ui/PageLoader";
type VisitSource = 'SCANNER' | 'WEB' | 'TYPED' | 'LEAD_MARKED' | 'FACILITY_CLOSE' | 'AUTO_CLOSE' | 'SYSTEM';

type Visit = {
  id: number;
  arrivedAt: string | null;
  departedAt?: string | null;
  arrivedVia?: VisitSource | null;
  departedVia?: VisitSource | null;
  person?: { name?: string | null; email?: string | null } | null;
  event?: { name?: string | null } | null;
};

const SOURCE_META: Record<VisitSource, { Icon: typeof IconScan; label: string }> = {
  SCANNER: { Icon: IconScan, label: 'Scanner (kiosk badge)' },
  WEB: { Icon: IconDeviceLaptop, label: 'Web (legacy typed form)' },
  TYPED: { Icon: IconDeviceLaptop, label: 'Typed (form clock, not a badge)' },
  LEAD_MARKED: { Icon: IconUserCheck, label: 'Marked present by staff (event window, not measured)' },
  FACILITY_CLOSE: { Icon: IconLock, label: 'Building closed (stamped at the close moment)' },
  AUTO_CLOSE: { Icon: IconRobot, label: 'Nightly sweep (stamped at cron-run time — likely late)' },
  SYSTEM: { Icon: IconRobot, label: 'Automated, pre-split (facility close or nightly — indistinguishable)' },
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

type RowNoticeState = { id: number; text: string; tone: AlertTone } | null;

const RowNotice = ({ notice, id, onClose }: { notice: RowNoticeState; id: number; onClose: () => void }) => {
  if (notice?.id !== id) return null;
  return (
    <Alert py={4} px="xs" color={notice.tone === 'success' ? 'treehouseGreen' : 'red'} variant="light" withCloseButton onClose={onClose}>
      {notice.text}
    </Alert>
  );
};

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

export default function AdminVisitsPage() {
  const { formatDateTime } = useOrgTime();
  const { ready, loading: authLoading } = useRequireRole(FACILITY_RECORD_ROLES);

  const [loading, setLoading] = useState(true);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [message, setMessage] = useState<{ text: string; tone: AlertTone } | null>(null);

  const [editingVisitId, setEditingVisitId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ arrivedAt: "", departedAt: "" });
  // Save error shown inline in the edited row's Actions cell — the row stays in
  // edit mode on failure, and the page-top banner lands off-screen on long tables
  // and reads as "nothing happened". Success uses the standard corner toast.
  const [rowNotice, setRowNotice] = useState<{ id: number; text: string; tone: AlertTone } | null>(null);

  // Insert-for-others: the walk-in path neither the kiosk (live only) nor the
  // event roster mark (program-scoped, event window) can record.
  const [addOpened, { open: openAdd, close: closeAdd }] = useDisclosure(false);
  const [people, setPeople] = useState<{ id: number; name: string | null; email: string }[]>([]);
  const [addForm, setAddForm] = useState({ personId: '', arrivedAt: '', departedAt: '' });
  const [addError, setAddError] = useState('');
  const [adding, setAdding] = useState(false);

  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'arrivedAt', dir: 'desc' });
  const [confirmEditOpened, { open: openConfirmEdit, close: closeConfirmEdit }] = useDisclosure(false);
  const [pendingEditVisit, setPendingEditVisit] = useState<Visit | null>(null);
  const [confirmDeleteOpened, { open: openConfirmDelete, close: closeConfirmDelete }] = useDisclosure(false);
  const [pendingDeleteVisit, setPendingDeleteVisit] = useState<Visit | null>(null);

  const sortedVisits = useMemo(() => {
    return [...visits].sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [visits, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });

  const SortableTh = ({ k, label }: { k: SortKey; label: string }) => {
    const active = sort.key === k;
    const Icon = !active ? IconSelector : sort.dir === 'asc' ? IconChevronUp : IconChevronDown;
    return (
      <Table.Th>
        <UnstyledButton onClick={() => toggleSort(k)} style={{ font: 'inherit' }}>
          <Group gap={4} wrap="nowrap">
            <span>{label}</span>
            <Icon size={14} stroke={1.5} />
          </Group>
        </UnstyledButton>
      </Table.Th>
    );
  };

  const fetchVisits = useCallback(async () => {
    try {
      const res = await fetch('/api/facility/visits');
      if (res.ok) {
        const data = await res.json();
        setVisits(data.visits);
      } else {
        setMessage({ text: "Failed to load visits.", tone: "error" });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error loading visits.", autoClose: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready) fetchVisits();
  }, [ready, fetchVisits]);

  // The Select is searchable over the whole directory the search endpoint returns.
  const openAddModal = async () => {
    setAddError('');
    setAddForm({ personId: '', arrivedAt: '', departedAt: '' });
    openAdd();
    if (people.length === 0) {
      const res = await fetch('/api/people/search');
      if (res.ok) {
        const data = await res.json();
        setPeople(data.people ?? []);
      }
    }
  };

  const handleAdd = async () => {
    // Instant feedback only — server remains the trust boundary.
    if (!addForm.personId) return setAddError('Choose a person.');
    if (!addForm.arrivedAt || !addForm.departedAt) return setAddError('Arrival and departure times are both required.');
    if (Date.parse(addForm.departedAt) <= Date.parse(addForm.arrivedAt)) {
      return setAddError('Departure time must be after arrival time');
    }
    if (Date.parse(addForm.departedAt) - Date.parse(addForm.arrivedAt) > MAX_VISIT_MS) {
      return setAddError('A visit cannot be longer than 24 hours.');
    }
    setAdding(true);
    try {
      const res = await fetch('/api/facility/visits/insert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personId: Number(addForm.personId),
          arrivedAt: fromDatetimeLocal(addForm.arrivedAt),
          departedAt: fromDatetimeLocal(addForm.departedAt),
        }),
      });
      if (res.ok) {
        notifications.show({ message: 'Visit added.' });
        closeAdd();
        fetchVisits();
      } else {
        const data = await res.json().catch(() => ({}));
        setAddError(data.error || 'Failed to add visit.');
      }
    } catch {
      notifications.show({ color: 'red', message: 'Network error adding visit.', autoClose: false });
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
    setRowNotice(null);
    setEditingVisitId(pendingEditVisit.id);
    setEditForm({
      arrivedAt: toDatetimeLocal(pendingEditVisit.arrivedAt),
      departedAt: toDatetimeLocal(pendingEditVisit.departedAt ?? null)
    });
    setPendingEditVisit(null);
  };

  const handleSaveEdit = async (id: number) => {
    // Instant feedback only — server remains the trust boundary.
    if (!editForm.departedAt) {
      setRowNotice({ id, text: "Departure time is required to close this visit.", tone: "error" });
      return;
    }
    if (editForm.arrivedAt && Date.parse(editForm.departedAt) <= Date.parse(editForm.arrivedAt)) {
      setRowNotice({ id, text: "Departure time must be after arrival time", tone: "error" });
      return;
    }
    if (editForm.arrivedAt && Date.parse(editForm.departedAt) - Date.parse(editForm.arrivedAt) > MAX_VISIT_MS) {
      setRowNotice({ id, text: "A visit cannot be longer than 24 hours.", tone: "error" });
      return;
    }
    try {
      const res = await fetch(`/api/facility/visits`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitId: id,
          arrivedAt: editForm.arrivedAt ? fromDatetimeLocal(editForm.arrivedAt) : undefined,
          departedAt: editForm.departedAt ? fromDatetimeLocal(editForm.departedAt) : undefined
        })
      });
      if (res.ok) {
        notifications.show({ message: "Visit updated successfully." });
        setEditingVisitId(null);
        fetchVisits();
      } else {
        const data = await res.json().catch(() => ({}));
        setRowNotice({ id, text: data.error || "Failed to update visit.", tone: "error" });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error saving visit.", autoClose: false });
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
      const res = await fetch(`/api/facility/visits`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitId: id })
      });
      if (res.ok) {
        notifications.show({ message: "Visit deleted." });
        fetchVisits();
      } else {
        const data = await res.json().catch(() => ({}));
        notifications.show({ color: "red", message: data.error || "Failed to delete visit.", autoClose: false });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error deleting visit.", autoClose: false });
    }
  };

  if (authLoading || loading) {
    return <PageLoader />;
  }

  if (!ready) return null;

  return (
    <Stack>
      <AlertBanner message={message?.text} tone={message?.tone} />

      <Group justify="flex-end">
        <Button size="xs" fz={15} onClick={openAddModal}>Add Visit</Button>
      </Group>

      <Table.ScrollContainer minWidth={800}>
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <SortableTh k="id" label="ID" />
              <SortableTh k="participant" label="Participant" />
              <SortableTh k="event" label="Event" />
              <SortableTh k="arrivedAt" label="Arrived" />
              <SortableTh k="departedAt" label="Departed" />
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
                        value={editForm.arrivedAt}
                        onChange={(e) => setEditForm({ ...editForm, arrivedAt: e.currentTarget.value })}
                      />
                    </Table.Td>
                    <Table.Td>
                      <TextInput
                        type="datetime-local"
                        size="xs"
                        value={editForm.departedAt}
                        onChange={(e) => setEditForm({ ...editForm, departedAt: e.currentTarget.value })}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={6}>
                        <Group gap="xs" wrap="nowrap">
                          <Button size="xs" fz={15} onClick={() => handleSaveEdit(v.id)}>Save</Button>
                          <Button size="xs" fz={15} variant="default" onClick={() => setEditingVisitId(null)}>Cancel</Button>
                        </Group>
                        <RowNotice notice={rowNotice} id={v.id} onClose={() => setRowNotice(null)} />
                      </Stack>
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
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Button size="xs" fz={15} variant="light" onClick={() => handleEditClick(v)}>Edit</Button>
                        <Button size="xs" fz={15} variant="light" color="red" onClick={() => handleDeleteClick(v)}>Delete</Button>
                      </Group>
                    </Table.Td>
                  </>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

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
          {addError && <Alert color="red">{addError}</Alert>}
          <Select
            label="Person"
            searchable
            data={people.map((p) => ({ value: String(p.id), label: p.name || p.email }))}
            value={addForm.personId || null}
            onChange={(v) => setAddForm({ ...addForm, personId: v ?? '' })}
          />
          <TextInput
            type="datetime-local"
            label="Arrived"
            value={addForm.arrivedAt}
            onChange={(e) => setAddForm({ ...addForm, arrivedAt: e.currentTarget.value })}
          />
          <TextInput
            type="datetime-local"
            label="Departed"
            value={addForm.departedAt}
            onChange={(e) => setAddForm({ ...addForm, departedAt: e.currentTarget.value })}
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
