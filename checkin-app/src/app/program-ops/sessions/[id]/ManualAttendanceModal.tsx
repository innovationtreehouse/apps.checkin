"use client";

import type { RefObject } from 'react';
import { Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import type { RosterMember, Visit } from './eventDetail';

export function ManualAttendanceModal({
  editingAttendance, visits, manualStatus, setManualStatus, manualArrived, setManualArrived,
  manualDeparted, setManualDeparted, manualDepartedError, setManualDepartedError, departedRef,
  actionLoading, onClose, onCancel, onSave,
}: {
  editingAttendance: RosterMember | null;
  visits: Visit[];
  manualStatus: "Present" | "Absent";
  setManualStatus: (status: "Present" | "Absent") => void;
  manualArrived: string;
  setManualArrived: (value: string) => void;
  manualDeparted: string;
  setManualDeparted: (value: string) => void;
  manualDepartedError: string | undefined;
  setManualDepartedError: (error: string | undefined) => void;
  departedRef: RefObject<HTMLInputElement | null>;
  actionLoading: boolean;
  onClose: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <Modal
      opened={!!editingAttendance}
      onClose={onClose}
      title={<Text span fw={700} fz="lg">Manual Edit: {editingAttendance?.person.name}</Text>}
      centered
    >
      <Stack>
        {(() => {
          const editingVisit = editingAttendance ? visits.find(v => v.personId === editingAttendance.personId) : undefined;
          const isCheckedIn = !!(editingVisit && !editingVisit.departedAt);
          return (
            <Select
              label="Status"
              value={manualStatus}
              onChange={(v) => setManualStatus((v as "Present" | "Absent") ?? "Present")}
              allowDeselect={false}
              data={[{ value: "Present", label: "Present" }, { value: "Absent", label: "Absent", disabled: isCheckedIn }]}
              description={isCheckedIn ? "Still checked in: they badge out at the kiosk, or the 11 PM close ends the visit." : undefined}
            />
          );
        })()}
        {manualStatus === "Present" && (
          <>
            <TextInput type="datetime-local" label="Arrived Time" value={manualArrived} onChange={(e) => { setManualArrived(e.currentTarget.value); setManualDepartedError(undefined); }} />
            <TextInput
              ref={departedRef}
              type="datetime-local"
              label="Departed Time"
              value={manualDeparted}
              error={manualDepartedError}
              onChange={(e) => { setManualDeparted(e.currentTarget.value); setManualDepartedError(undefined); }}
            />
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel} disabled={actionLoading}>Cancel</Button>
          <Button onClick={onSave} disabled={actionLoading} loading={actionLoading}>Save</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
