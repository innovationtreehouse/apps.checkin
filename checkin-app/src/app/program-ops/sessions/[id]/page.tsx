"use client";

import { useState, useEffect, use, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRequireRole } from '@/hooks/useRequireRole';
import { Alert, Badge, Button, Card, Checkbox, Container, Group, Modal, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { AlertBanner } from '@/components/admin/AlertBanner';
import { toDatetimeLocal, fromDatetimeLocal } from '@/lib/time';
import { useOrgTime } from '@/components/TimezoneProvider';
import { MAX_VISIT_MS } from '@/lib/visitTimes';
import type { RSVPStatus } from '@/types/rsvp';

import { PageLoader } from "@/components/ui/PageLoader";
type ParticipantDetail = {
  personId: number;
  person: {
    id: number;
    name: string | null;
    email: string;
  };
  isCore?: boolean;
};

type EventData = {
  id: number;
  name: string;
  startAt: string;
  endAt: string;
  attendanceConfirmedAt: string | null;
  attendanceConfirmedBy?: { name: string | null } | null;
  recurringGroupId: string | null;
  program?: {
    id: number;
    name: string;
    leadMentorId: number | null;
    volunteers: ParticipantDetail[];
    participants: ParticipantDetail[];
  };
  visits: {
    id: number;
    personId: number;
    arrivedAt: string;
    departedAt: string | null;
  }[];
  rsvps: { personId: number; status: RSVPStatus }[];
};

const RSVP_BADGE: Record<RSVPStatus, { label: string; color: string }> = {
  ATTENDING: { label: 'Attending', color: 'treehouseGreen' },
  MAYBE: { label: 'Maybe', color: 'yellow' },
  NOT_ATTENDING: { label: 'Not attending', color: 'red' },
  NO_RESPONSE: { label: 'No response', color: 'gray' },
};

export default function EventAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const { formatDateTime } = useOrgTime();
  const { id } = use(params);
  const { user: sessionUser, loading: authLoading, ready } = useRequireRole([]);
  const router = useRouter();
  // Leads reach this screen from their My Programs inbox (?from=my-programs).
  // When they do, "back" and post-confirm return there instead of the board's
  // program-edit page. Board/program-ops flow (no param) is unchanged.
  const searchParams = useSearchParams();
  const fromMyPrograms = searchParams.get('from') === 'my-programs';

  const [eventData, setEventData] = useState<EventData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  // Action-confirmation notices rendered next to their triggering button, not
  // the far-off page-top banner (which reads as "nothing happened" on long pages).
  const [attendanceNotice, setAttendanceNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [timeNotice, setTimeNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [manualNotice, setManualNotice] = useState<{ ok: boolean; msg: string } | null>(null);

  // Edit states
  const [editMode, setEditMode] = useState(false);
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [applyToFuture, setApplyToFuture] = useState(false);
  const [confirmCancelOpened, { open: openConfirmCancel, close: closeConfirmCancel }] = useDisclosure(false);

  // Manual Edit States
  const [editingAttendance, setEditingAttendance] = useState<(ParticipantDetail & { role: string }) | null>(null);
  const [manualStatus, setManualStatus] = useState<"Present" | "Absent">("Present");
  const [manualArrived, setManualArrived] = useState("");
  const [manualDeparted, setManualDeparted] = useState("");

  const loadEvent = useCallback(() => fetch(`/api/events/${id}`)
    .then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setEventData(data);

        const startStr = toDatetimeLocal(data.startAt);
        const endStr = toDatetimeLocal(data.endAt);
        setNewStart(startStr);
        setNewEnd(endStr);
      } else {
        setMessage("Failed to load event.");
      }
    })
    .catch(() => {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    })
    .finally(() => {
      setLoading(false);
    }),
  [id]);

  const fetchEvent = useCallback(() => {
    setLoading(true);
    return loadEvent();
  }, [loadEvent]);

  useEffect(() => {
    if (ready) loadEvent();
  }, [ready, loadEvent]);

  const handleConfirmAttendance = async () => {
    setActionLoading(true);
    setAttendanceNotice(null);
    try {
      const res = await fetch(`/api/events/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirmAttendance' })
      });
      if (res.ok) {
        // From the lead's inbox, the work is done → return to My Programs (the
        // item drops off there). Board/program-ops flow stays on the page.
        if (fromMyPrograms) {
          router.push('/my-programs');
          return;
        }
        notifications.show({ message: "Attendance confirmed successfully!" });
        fetchEvent();
      } else {
        const data = await res.json().catch(() => ({}));
        setAttendanceNotice({ ok: false, msg: data.error || "Failed to confirm attendance." });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setActionLoading(false);
    }
  };

  const handleEditTime = async () => {
    setActionLoading(true);
    setTimeNotice(null);
    try {
      const startIso = fromDatetimeLocal(newStart);
      const endIso = fromDatetimeLocal(newEnd);

      const res = await fetch(`/api/events/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'editTime', startAt: startIso, endAt: endIso, applyToFuture })
      });
      if (res.ok) {
        notifications.show({ message: "Event time updated successfully!" });
        setEditMode(false);
        fetchEvent();
      } else {
        const data = await res.json().catch(() => ({}));
        if (data.error === "Cannot edit a past event") {
          notifications.show({ color: "red", message: data.error, autoClose: 4000 });
          setEditMode(false);
          fetchEvent();
        } else {
          setTimeNotice({ ok: false, msg: data.error || "Failed to edit event." });
        }
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveManualAttendance = async () => {
    if (!editingAttendance) return;
    // Instant feedback only — server remains the trust boundary.
    if (manualStatus === 'Present' && manualArrived && manualDeparted &&
        Date.parse(manualDeparted) <= Date.parse(manualArrived)) {
      setManualNotice({ ok: false, msg: "Departure time must be after arrival time" });
      return;
    }
    if (manualStatus === 'Present' && manualArrived && manualDeparted &&
        Date.parse(manualDeparted) - Date.parse(manualArrived) > MAX_VISIT_MS) {
      setManualNotice({ ok: false, msg: "A visit cannot be longer than 24 hours." });
      return;
    }
    setActionLoading(true);
    setManualNotice(null);
    try {
      const res = await fetch(`/api/events/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'manualEditAttendance',
          participantId: editingAttendance.personId,
          status: manualStatus,
          arrivedAt: manualStatus === 'Present' ? fromDatetimeLocal(manualArrived) : null,
          departedAt: manualStatus === 'Present' && manualDeparted ? fromDatetimeLocal(manualDeparted) : null
        })
      });
      if (res.ok) {
        // Success closes the modal; the refreshed roster row shows the change.
        setEditingAttendance(null);
        fetchEvent();
      } else {
        // Keep the modal open so the error is visible next to Save.
        const data = await res.json().catch(() => ({}));
        setManualNotice({ ok: false, msg: data.error || "Failed to update attendance." });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancelEvent = async () => {
    closeConfirmCancel();
    setActionLoading(true);
    try {
      const res = await fetch(`/api/events/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', applyToFuture })
      });
      if (res.ok) {
        router.push(eventData?.program?.id ? `/program-ops/programs/${eventData.program.id}` : '/program-ops/programs');
      } else {
        const data = await res.json().catch(() => ({}));
        setMessage(data.error || "Failed to cancel event.");
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setActionLoading(false);
    }
  };

  if (loading || authLoading) {
    return <PageLoader />;
  }

  if (!ready) return null;

  if (!eventData) {
    return (
      <Container size="sm" py="xl">
        <Card withBorder radius="md" padding="xl" ta="center">
          <Title order={3}>{message || "Not Found"}</Title>
          <Group justify="center" mt="lg"><Button onClick={() => router.back()}>Go Back</Button></Group>
        </Card>
      </Container>
    );
  }

  const user = sessionUser as unknown as { id: number; isSysadmin?: boolean; isBoardMember?: boolean };
  const userId = user?.id;
  const isSysAdminOrBoard = user?.isSysadmin || user?.isBoardMember;
  const isLeadMentor = eventData.program?.leadMentorId === userId;
  const isCoreVolunteer = eventData.program?.volunteers?.some(v => v.personId === userId && v.isCore) || false;

  const canManageAttendance = isSysAdminOrBoard || isLeadMentor || isCoreVolunteer;
  const canManageEventInfo = isSysAdminOrBoard || isLeadMentor;

  const isPastEvent = new Date(eventData.endAt) < new Date();

  const renderRosterGrid = () => {
    if (!eventData.program) return null;

    const allRoster = [
      ...eventData.program.volunteers.map(v => ({ ...v, role: v.isCore ? 'Core Volunteer' : 'Volunteer' })),
      ...eventData.program.participants.map(p => ({ ...p, role: 'Participant' }))
    ];

    const ROLE_RANK: Record<string, number> = { 'Core Volunteer': 1, 'Volunteer': 2, 'Participant': 3 };

    allRoster.sort((a, b) => {
      if (ROLE_RANK[a.role] !== ROLE_RANK[b.role]) return ROLE_RANK[a.role] - ROLE_RANK[b.role];
      return (a.person.name || "").localeCompare(b.person.name || "");
    });

    return (
      <Table.ScrollContainer minWidth={600} mt="md">
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Role</Table.Th>
              <Table.Th>Status / Time</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {allRoster.map((member) => {
              const visit = eventData.visits.find(v => v.personId === member.personId);
              let statusEl;
              if (visit) {
                const arriveTime = new Date(visit.arrivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const leaveTime = visit.departedAt ? new Date(visit.departedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Still Here';
                statusEl = <Text component="span" c="green">Arrived: {arriveTime} {visit.departedAt ? `| Left: ${leaveTime}` : ''}</Text>;
              } else {
                statusEl = <Text component="span" c="red">Absent</Text>;
              }

              return (
                <Table.Tr key={`${member.role}-${member.personId}`}>
                  <Table.Td>
                    <Text fw={500}>{member.person.name || 'Unnamed'}</Text>
                    <Text size="xs" c="dimmed">{member.person.email}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={member.role === 'Participant' ? 'cyan' : 'yellow'} variant="light">{member.role}</Badge>
                  </Table.Td>
                  <Table.Td>
                    <Group justify="space-between" wrap="nowrap">
                      {statusEl}
                      {canManageAttendance && (
                        <Button size="compact-xs" variant="light" onClick={() => {
                          setManualNotice(null);
                          setEditingAttendance(member);
                          if (visit) {
                            setManualStatus("Present");
                            setManualArrived(toDatetimeLocal(visit.arrivedAt));
                            setManualDeparted(visit.departedAt ? toDatetimeLocal(visit.departedAt) : "");
                          } else {
                            setManualStatus("Absent");
                            setManualArrived(toDatetimeLocal(eventData.startAt));
                            setManualDeparted(toDatetimeLocal(eventData.endAt));
                          }
                        }}>
                          Manual Edit
                        </Button>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
            {allRoster.length === 0 && (
              <Table.Tr><Table.Td colSpan={3} ta="center"><Text c="dimmed" py="md">No roster found for this program.</Text></Table.Td></Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    );
  };

  const renderRsvpList = () => {
    if (!eventData.program) return null;

    const statusByParticipant = new Map(eventData.rsvps.map(r => [r.personId, r.status]));
    const roster = [
      ...eventData.program.volunteers.map(v => ({ ...v, role: v.isCore ? 'Core Volunteer' : 'Volunteer' })),
      ...eventData.program.participants.map(p => ({ ...p, role: 'Participant' })),
    ];
    const ROLE_RANK: Record<string, number> = { 'Core Volunteer': 1, 'Volunteer': 2, 'Participant': 3 };
    roster.sort((a, b) =>
      ROLE_RANK[a.role] !== ROLE_RANK[b.role]
        ? ROLE_RANK[a.role] - ROLE_RANK[b.role]
        : (a.person.name || "").localeCompare(b.person.name || "")
    );

    return (
      <Card withBorder radius="md" padding="lg" mb="lg">
        <Title order={4} mb="md">RSVPs</Title>
        <Table.ScrollContainer minWidth={400}>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Role</Table.Th>
                <Table.Th>RSVP</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {roster.map((member) => {
                const badge = RSVP_BADGE[statusByParticipant.get(member.personId) ?? 'NO_RESPONSE'];
                return (
                  <Table.Tr key={`${member.role}-${member.personId}`}>
                    <Table.Td>
                      <Text fw={500}>{member.person.name || 'Unnamed'}</Text>
                      <Text size="xs" c="dimmed">{member.person.email}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={member.role === 'Participant' ? 'cyan' : 'yellow'} variant="light">{member.role}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={badge.color} variant="light">{badge.label}</Badge>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
              {roster.length === 0 && (
                <Table.Tr><Table.Td colSpan={3} ta="center"><Text c="dimmed" py="md">No roster found for this program.</Text></Table.Td></Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
    );
  };

  return (
    <Container size="lg" pb="md">
      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" align="flex-start" wrap="wrap" mb="lg">
          <div>
            <Title order={1}>{eventData.name}</Title>
            <Text c="dimmed" fz="lg">{formatDateTime(eventData.startAt)} - {formatDateTime(eventData.endAt)}</Text>
          </div>
          <Button
            variant="default"
            onClick={() =>
              router.push(
                fromMyPrograms
                  ? '/my-programs'
                  : eventData.program?.id
                    ? `/program-ops/programs/${eventData.program.id}`
                    : '/program-ops/programs',
              )
            }
          >
            {fromMyPrograms ? '← Back to My Programs' : '← Back to Program'}
          </Button>
        </Group>

        <AlertBanner message={message} tone="error" mb="lg" />

        {/* PAST EVENT: ATTENDANCE CONFIRMATION */}
        {isPastEvent && canManageAttendance && (
          <Card withBorder radius="md" padding="lg" mb="lg">
            <Group justify="space-between" align="center" wrap="wrap">
              <div>
                <Title order={4}>Attendance Tracking</Title>
                <Text c="dimmed">Review program badge scans below and confirm final attendance.</Text>
              </div>
              {eventData.attendanceConfirmedAt ? (
                <Group align="center" gap="md">
                  <Text size="sm" c="dimmed" ta="right">
                    Confirmed on {new Date(eventData.attendanceConfirmedAt).toLocaleDateString()}
                    <br />by {eventData.attendanceConfirmedBy?.name || 'Unknown'}
                  </Text>
                  <Button variant="default" onClick={handleConfirmAttendance} disabled={actionLoading}>Re-confirm</Button>
                </Group>
              ) : (
                <Button onClick={handleConfirmAttendance} disabled={actionLoading} loading={actionLoading}>Confirm Attendance</Button>
              )}
            </Group>
            {attendanceNotice && (
              <Alert color={attendanceNotice.ok ? 'treehouseGreen' : 'red'} variant="light" mt="md" withCloseButton onClose={() => setAttendanceNotice(null)}>
                {attendanceNotice.msg}
              </Alert>
            )}
            {renderRosterGrid()}
          </Card>
        )}

        {/* ENROLLED INDIVIDUALS + RSVP STATUS */}
        {renderRsvpList()}

        {/* FUTURE EVENT: EDIT / CANCEL */}
        {!isPastEvent && canManageEventInfo && (
          <Card withBorder radius="md" padding="lg" mb="lg">
            <Title order={4} mb="lg">Manage Event</Title>

            {timeNotice && (
              <Alert color={timeNotice.ok ? 'treehouseGreen' : 'red'} variant="light" mb="lg" withCloseButton onClose={() => setTimeNotice(null)}>
                {timeNotice.msg}
              </Alert>
            )}

            {!editMode ? (
              <Group>
                <Button variant="light" onClick={() => setEditMode(true)}>Edit Date / Time</Button>
                <Button variant="light" color="red" onClick={() => setEditMode(true)}>Cancel Event</Button>
              </Group>
            ) : (
              <Stack>
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput type="datetime-local" label="Start Time" value={newStart} onChange={e => setNewStart(e.currentTarget.value)} />
                  <TextInput type="datetime-local" label="End Time" value={newEnd} onChange={e => setNewEnd(e.currentTarget.value)} />
                </SimpleGrid>

                {eventData.recurringGroupId && (
                  <Alert color="yellow" variant="light">
                    <Checkbox
                      checked={applyToFuture}
                      onChange={e => setApplyToFuture(e.currentTarget.checked)}
                      label={<span><strong>Apply to Series:</strong> Apply these changes (time shift or cancellation) to this event and all FUTURE events in this recurring set.</span>}
                    />
                  </Alert>
                )}

                <Group>
                  <Button onClick={handleEditTime} disabled={actionLoading} loading={actionLoading}>Save Time Changes</Button>
                  <Button color="red" variant="light" onClick={openConfirmCancel} disabled={actionLoading} loading={actionLoading}>Cancel Event(s)</Button>
                  <Button variant="default" onClick={() => setEditMode(false)} disabled={actionLoading} ml="auto">Nevermind</Button>
                </Group>
              </Stack>
            )}
          </Card>
        )}

        {/* Fallback for Core Volunteers on future events */}
        {!isPastEvent && !canManageEventInfo && canManageAttendance && (
          <Alert color="gray" variant="light" ta="center">
            <Text>This is a scheduled future event. Attendance tracking will become available once the event has concluded.</Text>
            <Text size="sm" mt="xs">Only Program Leads and Administrators can modify or cancel future events.</Text>
          </Alert>
        )}

        {/* If it's a past event but they aren't authorized to manage attendance */}
        {isPastEvent && !canManageAttendance && (
          <Alert color="gray" variant="light" ta="center">
            This is a past event. You do not have permission to manage attendance for this program.
          </Alert>
        )}
      </Card>

      <Modal
        opened={!!editingAttendance}
        onClose={() => !actionLoading && (setEditingAttendance(null), setManualNotice(null))}
        title={<Text span fw={700} fz="lg">Manual Edit: {editingAttendance?.person.name}</Text>}
        centered
      >
        <Stack>
          {(() => {
            const editingVisit = editingAttendance ? eventData.visits.find(v => v.personId === editingAttendance.personId) : undefined;
            const isCheckedIn = !!(editingVisit && !editingVisit.departedAt);
            return (
              <Select
                label="Status"
                value={manualStatus}
                onChange={(v) => setManualStatus((v as "Present" | "Absent") ?? "Present")}
                allowDeselect={false}
                data={[{ value: "Present", label: "Present" }, { value: "Absent", label: "Absent", disabled: isCheckedIn }]}
                description={isCheckedIn ? "Check them out first to mark Absent." : undefined}
              />
            );
          })()}
          {manualStatus === "Present" && (
            <>
              <TextInput type="datetime-local" label="Arrived Time" value={manualArrived} onChange={(e) => setManualArrived(e.currentTarget.value)} />
              <TextInput type="datetime-local" label="Departed Time (Optional)" value={manualDeparted} onChange={(e) => setManualDeparted(e.currentTarget.value)} />
            </>
          )}
          {manualNotice && (
            <Alert color={manualNotice.ok ? 'treehouseGreen' : 'red'} variant="light" withCloseButton onClose={() => setManualNotice(null)}>
              {manualNotice.msg}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setEditingAttendance(null)} disabled={actionLoading}>Cancel</Button>
            <Button onClick={handleSaveManualAttendance} disabled={actionLoading} loading={actionLoading}>Save</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={confirmCancelOpened}
        onClose={closeConfirmCancel}
        title={<Text span fw={700} fz="lg">Cancel Event</Text>}
        centered
      >
        <Text mb="lg">Are you sure you want to cancel this event? This action cannot be undone.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeConfirmCancel}>Nevermind</Button>
          <Button color="red" onClick={handleCancelEvent} disabled={actionLoading} loading={actionLoading}>Cancel Event(s)</Button>
        </Group>
      </Modal>
    </Container>
  );
}
