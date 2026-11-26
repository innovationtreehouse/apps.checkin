"use client";

import { useState, use, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRequireRole } from '@/hooks/useRequireRole';
import { Alert, Button, Card, Container, Group, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { errorMessage, HttpError, LoadError, showError, showSuccess } from '@checkin/component-ui';
import { useSeedForm } from '@/hooks/useSeedForm';
import { api, useLoad } from '@/lib/api';
import { toDatetimeLocal, fromDatetimeLocal } from '@/lib/time';
import { useOrgTime } from '@/components/TimezoneProvider';
import { MAX_VISIT_MS } from '@/lib/visitTimes';

import { PageLoader } from "@/components/ui/PageLoader";
import { AttendanceCard } from './AttendanceCard';
import { CancelEventModal } from './CancelEventModal';
import { ManageEventCard } from './ManageEventCard';
import { ManualAttendanceModal } from './ManualAttendanceModal';
import { RsvpList } from './RsvpList';
import type { EventData, RosterMember, Visit } from './eventDetail';

export default function EventAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const { formatDateTime } = useOrgTime();
  const { id } = use(params);
  const { user: sessionUser, loading: authLoading, ready } = useRequireRole([]);
  const router = useRouter();
  // Leads reach this screen from their Programs I Lead inbox (?from=programs-i-lead).
  // When they do, "back" and post-confirm return there instead of the board's
  // program-edit page. Board/program-ops flow (no param) is unchanged.
  const searchParams = useSearchParams();
  const fromProgramsILead = searchParams.get('from') === 'programs-i-lead';

  const { data: eventData, error: loadError, reload } = useLoad<EventData>(ready ? `/api/events/${id}` : null);
  const [actionLoading, setActionLoading] = useState(false);
  const [manualDepartedError, setManualDepartedError] = useState<string | undefined>();
  const manualDepartedRef = useRef<HTMLInputElement>(null);

  // Edit states
  const [editMode, setEditMode] = useState(false);
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [applyToFuture, setApplyToFuture] = useState(false);
  const [confirmCancelOpened, { open: openConfirmCancel, close: closeConfirmCancel }] = useDisclosure(false);

  // Manual Edit States
  const [editingAttendance, setEditingAttendance] = useState<RosterMember | null>(null);
  const [manualStatus, setManualStatus] = useState<"Present" | "Absent">("Present");
  const [manualArrived, setManualArrived] = useState("");
  const [manualDeparted, setManualDeparted] = useState("");

  useSeedForm(eventData, editMode, (event) => {
    setNewStart(toDatetimeLocal(event.startAt));
    setNewEnd(toDatetimeLocal(event.endAt));
  });

  const handleConfirmAttendance = async () => {
    setActionLoading(true);
    try {
      await api(`/api/events/${id}`, { method: 'PATCH', body: JSON.stringify({ action: 'confirmAttendance' }) });
      // From the lead's inbox the work is done, so return to Programs I Lead, where the item drops off.
      if (fromProgramsILead) {
        router.push('/programs-i-lead');
        return;
      }
      showSuccess("Attendance confirmed successfully!");
      await reload();
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setActionLoading(false);
    }
  };

  const handleEditTime = async () => {
    setActionLoading(true);
    try {
      await api(`/api/events/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'editTime', startAt: fromDatetimeLocal(newStart), endAt: fromDatetimeLocal(newEnd), applyToFuture })
      });
      showSuccess("Event time updated successfully!");
      setEditMode(false);
      await reload();
    } catch (e) {
      showError(errorMessage(e));
      if (e instanceof HttpError && e.message === "Cannot edit a past event") {
        setEditMode(false);
        await reload();
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveManualAttendance = async () => {
    if (!editingAttendance) return;
    // Instant feedback only — server remains the trust boundary.
    const departedError = manualStatus !== 'Present' ? undefined
      : !manualDeparted ? "Departure time is required for Present status"
      : manualArrived && Date.parse(manualDeparted) <= Date.parse(manualArrived) ? "Departure time must be after arrival time"
      : manualArrived && Date.parse(manualDeparted) - Date.parse(manualArrived) > MAX_VISIT_MS ? "A visit cannot be longer than 24 hours."
      : undefined;
    setManualDepartedError(departedError);
    if (departedError) {
      manualDepartedRef.current?.focus();
      return;
    }
    setActionLoading(true);
    try {
      await api(`/api/events/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'manualEditAttendance',
          participantId: editingAttendance.personId,
          status: manualStatus,
          arrivedAt: manualStatus === 'Present' ? fromDatetimeLocal(manualArrived) : null,
          departedAt: manualStatus === 'Present' && manualDeparted ? fromDatetimeLocal(manualDeparted) : null
        })
      });
      // Success closes the modal; the refreshed roster row shows the change.
      setEditingAttendance(null);
      await reload();
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancelEvent = async () => {
    closeConfirmCancel();
    setActionLoading(true);
    try {
      await api(`/api/events/${id}`, { method: 'PATCH', body: JSON.stringify({ action: 'cancel', applyToFuture }) });
      router.push(eventData?.program?.id ? `/program-ops/programs/${eventData.program.id}` : '/program-ops/programs');
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setActionLoading(false);
    }
  };

  if (authLoading) {
    return <PageLoader />;
  }

  if (!ready) return null;

  if (!eventData) {
    if (!loadError) return <PageLoader />;
    return (
      <Container size="sm" py="xl">
        <Card withBorder radius="md" padding="xl">
          <LoadError what="the event" message={loadError} onRetry={reload} />
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

  const openManualEdit = (member: RosterMember, visit: Visit | undefined) => {
    setManualDepartedError(undefined);
    setEditingAttendance(member);
    if (visit) {
      setManualStatus("Present");
      setManualArrived(toDatetimeLocal(visit.arrivedAt));
      setManualDeparted(visit.departedAt ? toDatetimeLocal(visit.departedAt) : "");
    } else {
      setManualStatus("Absent");
      setManualArrived(toDatetimeLocal(eventData.startAt));
      setManualDeparted(toDatetimeLocal(new Date(Math.min(Date.parse(eventData.endAt), Date.now())).toISOString()));
    }
  };

  const closeManualEdit = () => !actionLoading && (setEditingAttendance(null), setManualDepartedError(undefined));

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
                fromProgramsILead
                  ? '/programs-i-lead'
                  : eventData.program?.id
                    ? `/program-ops/programs/${eventData.program.id}`
                    : '/program-ops/programs',
              )
            }
          >
            {fromProgramsILead ? '← Back to Programs I Lead' : '← Back to Program'}
          </Button>
        </Group>

        {loadError && <LoadError what="the event" message={loadError} onRetry={reload} />}

        {/* PAST EVENT: ATTENDANCE CONFIRMATION */}
        {isPastEvent && canManageAttendance && (
          <AttendanceCard
            eventData={eventData}
            actionLoading={actionLoading}
            onConfirm={handleConfirmAttendance}
            canManageAttendance={canManageAttendance}
            onManualEdit={openManualEdit}
          />
        )}

        {/* ENROLLED INDIVIDUALS + RSVP STATUS */}
        <RsvpList eventData={eventData} />

        {/* FUTURE EVENT: EDIT / CANCEL */}
        {!isPastEvent && canManageEventInfo && (
          <ManageEventCard
            editMode={editMode}
            setEditMode={setEditMode}
            newStart={newStart}
            setNewStart={setNewStart}
            newEnd={newEnd}
            setNewEnd={setNewEnd}
            applyToFuture={applyToFuture}
            setApplyToFuture={setApplyToFuture}
            recurringGroupId={eventData.recurringGroupId}
            actionLoading={actionLoading}
            onSave={handleEditTime}
            onCancelClick={openConfirmCancel}
          />
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

      <ManualAttendanceModal
        editingAttendance={editingAttendance}
        visits={eventData.visits}
        manualStatus={manualStatus}
        setManualStatus={setManualStatus}
        manualArrived={manualArrived}
        setManualArrived={setManualArrived}
        manualDeparted={manualDeparted}
        setManualDeparted={setManualDeparted}
        manualDepartedError={manualDepartedError}
        setManualDepartedError={setManualDepartedError}
        departedRef={manualDepartedRef}
        actionLoading={actionLoading}
        onClose={closeManualEdit}
        onCancel={() => setEditingAttendance(null)}
        onSave={handleSaveManualAttendance}
      />

      <CancelEventModal
        opened={confirmCancelOpened}
        onClose={closeConfirmCancel}
        onConfirm={handleCancelEvent}
        actionLoading={actionLoading}
      />
    </Container>
  );
}
