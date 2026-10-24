"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Badge, Button, Card, Group, Stack, Table, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconTrash } from "@tabler/icons-react";
import { useOrgTime } from '@/components/TimezoneProvider';
import { useConflicts } from "@/hooks/useConflicts";
import { notifyNavRefresh } from "@/lib/nav-refresh";
import type { AttendanceConflict, ConflictVisit } from "@/lib/attendanceConflicts";

/**
 * Conflicts subtab: duplicate / overlapping Visit rows for the lead's programs.
 * Each card shows a participant + the led event, the overlapping visits, and a
 * Delete affordance to drop a duplicate. Detection is read-only (computed on
 * view); deleting is the only write, and it's audited + re-authorized server-side.
 */
export default function ConflictsPage() {
  const { status } = useSession();
  const { conflicts, refresh } = useConflicts(status === "authenticated");
  const [deleting, setDeleting] = useState<number | null>(null);

  async function resolve(visitId: number) {
    setDeleting(visitId);
    try {
      const res = await fetch("/api/my-programs/conflicts/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        notifications.show({ message: "Duplicate visit deleted." });
        refresh();
        notifyNavRefresh();
      } else {
        notifications.show({ color: "red", message: data.error || "Failed to delete visit.", autoClose: false });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setDeleting(null);
    }
  }

  function confirmDelete(visitId: number) {
    modals.openConfirmModal({
      title: "Delete duplicate visit?",
      children: <Text size="sm">This permanently deletes visit #{visitId}. This cannot be undone.</Text>,
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => resolve(visitId),
    });
  }

  if (conflicts === null) return <Text c="dimmed">Loading conflicts…</Text>;
  if (conflicts.length === 0) {
    return <Text c="dimmed">No attendance conflicts. Duplicate or overlapping check-ins would show here.</Text>;
  }

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {conflicts.length} participant{conflicts.length === 1 ? "" : "s"} with overlapping visits. Delete the duplicate to leave one clean visit.
      </Text>
      {conflicts.map((c, i) => (
        <ConflictCard key={`${c.participantId}-${c.eventId}-${i}`} conflict={c} deleting={deleting} onDelete={confirmDelete} />
      ))}
    </Stack>
  );
}

function ConflictCard({
  conflict,
  deleting,
  onDelete,
}: {
  conflict: AttendanceConflict;
  deleting: number | null;
  onDelete: (visitId: number) => void;
}) {
  return (
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" mb="sm">
        <Text fw={600}>{conflict.participantName}</Text>
        <Text size="sm" c="dimmed">{conflict.eventName}</Text>
      </Group>
      <Table withRowBorders={false} verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Visit</Table.Th>
            <Table.Th>When</Table.Th>
            <Table.Th>Via</Table.Th>
            <Table.Th>Event</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {conflict.visits.map((v) => (
            <VisitRow key={v.id} visit={v} deleting={deleting} onDelete={onDelete} />
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
}

function VisitRow({
  visit,
  deleting,
  onDelete,
}: {
  visit: ConflictVisit;
  deleting: number | null;
  onDelete: (visitId: number) => void;
}) {
  const { formatDate, formatVisitRange } = useOrgTime();
  const via = [visit.arrivedVia, visit.departedVia].filter(Boolean).join(" / ") || "—";
  return (
    <Table.Tr>
      <Table.Td>#{visit.id}</Table.Td>
      <Table.Td>
        <Text size="sm">{formatDate(visit.arrivedAt)}</Text>
        <Text size="sm">
          {formatVisitRange(visit.arrivedAt, visit.departedAt ?? undefined)}
          {visit.departedAt === null && <Badge ml="xs" size="xs" color="gray">open</Badge>}
        </Text>
      </Table.Td>
      <Table.Td>{via}</Table.Td>
      <Table.Td>{visit.associatedEventId ?? <Text c="dimmed" size="sm">unassociated</Text>}</Table.Td>
      <Table.Td>
        <Button
          size="xs"
          variant="light"
          color="red"
          leftSection={<IconTrash size={14} />}
          loading={deleting === visit.id}
          onClick={() => onDelete(visit.id)}
        >
          Delete
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}
