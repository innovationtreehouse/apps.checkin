"use client";

import { useCallback, useEffect, useState } from "react";
import { ActionIcon, Alert, Button, Card, Group, Table, Text, TextInput, Title } from "@mantine/core";
import { IconPencil, IconTrash, IconX } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageLoader } from "@/components/ui/PageLoader";
import { useRequireRole } from "@/hooks/useRequireRole";
import { notifyNavRefresh } from "@/lib/nav-refresh";
import { toDatetimeLocal } from "@/lib/time";
import { useOrgTime } from '@/components/TimezoneProvider';
import { AttendanceTabs } from "../AttendanceTabs";
import { isCloseChoiceWarning, useCloseChoice } from "@/components/CloseChoiceDialog";

type Visit = {
  id: number;
  arrivedAt: string;
  departedAt: string | null;
  event: { name: string } | null;
};

// Self-correction of the member's own visits: every row is editable and
// deletable, no approval step — significant changes are flagged to the board
// server-side (trust-first, design doc 1256_ATTENDANCE_CORRECTION_SURFACE.md).
export default function MyVisits() {
  const { formatVisitRange } = useOrgTime();
  const { ready, loading: authLoading } = useRequireRole([]);
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const { ask: askCloseChoice, dialog: closeChoiceDialog } = useCloseChoice();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [arrivedAt, setArrived] = useState("");
  const [departedAt, setDeparted] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/profile/visits");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || "Failed to load visits.");
      else setVisits(data.visits);
    } catch {
      setError("Network error occurred.");
    }
  }, []);

  useEffect(() => { if (ready) void load(); }, [ready, load]);

  const startEdit = (v: Visit) => {
    setEditing(v.id);
    setArrived(toDatetimeLocal(v.arrivedAt));
    setDeparted(v.departedAt ? toDatetimeLocal(v.departedAt) : "");
  };

  const submit = async (id: number, init: RequestInit, okMessage: string) => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/attendance/manual/${id}`, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (isCloseChoiceWarning(data)) {
          const answer = await askCloseChoice(data, { removal: init.method === "DELETE" });
          if (answer) {
            const body = JSON.parse(typeof init.body === "string" ? init.body : "{}");
            await submit(id, { ...init, body: JSON.stringify({ ...body, ...answer }) }, okMessage);
          }
        } else {
          setError(data.error || "Correction failed.");
        }
      } else {
        notifications.show({ message: okMessage });
        setEditing(null);
        await load();
        notifyNavRefresh();
      }
    } catch {
      notifications.show({ color: "red", message: "Network error occurred.", autoClose: false });
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = (id: number) =>
    submit(id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // datetime-local is naive — send a real instant (same rule as manual entry).
      body: JSON.stringify({
        arrivedAt: arrivedAt ? new Date(arrivedAt).toISOString() : "",
        departedAt: departedAt ? new Date(departedAt).toISOString() : "",
      }),
    }, "Visit updated.");

  const remove = (v: Visit) => {
    if (!window.confirm("Delete this visit? It will no longer count toward your hours.")) return;
    void submit(v.id, { method: "DELETE" }, "Visit deleted.");
  };

  if (authLoading) return <PageLoader />;
  if (!ready) return null;

  return (
    <PageContainer>
      {closeChoiceDialog}
      <AttendanceTabs />
      <Card withBorder radius="md" padding="lg">
        <Title order={1} mb="md">My Visits</Title>
        <Text c="dimmed" mb="lg">
          Your visits from the last two weeks. Your hours are calculated from
          these records — fix a wrong time or remove a mistaken entry directly.
        </Text>

        {error && <Alert color="red" mb="md">{error}</Alert>}
        {!visits ? <PageLoader /> : visits.length === 0 ? (
          <Text c="dimmed">No visits in the last two weeks.</Text>
        ) : (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Date</Table.Th>
                <Table.Th>Time</Table.Th>
                <Table.Th>Event</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visits.map((v) => (
                <Table.Tr key={v.id}>
                  <Table.Td>{new Date(v.arrivedAt).toLocaleDateString()}</Table.Td>
                  <Table.Td>
                    {editing === v.id ? (
                      <Group gap="xs" wrap="nowrap">
                        <TextInput type="datetime-local" size="xs" value={arrivedAt}
                          onChange={(e) => setArrived(e.currentTarget.value)} aria-label="Arrival time" />
                        <TextInput type="datetime-local" size="xs" value={departedAt}
                          onChange={(e) => setDeparted(e.currentTarget.value)} aria-label="Departure time" />
                      </Group>
                    ) : (
                      formatVisitRange(v.arrivedAt, v.departedAt)
                    )}
                  </Table.Td>
                  <Table.Td>{v.event?.name ?? "—"}</Table.Td>
                  <Table.Td>
                    {editing === v.id ? (
                      <Group gap="xs" wrap="nowrap">
                        {/* A closed visit stays closed — the server ignores a
                            cleared departure, so don't offer a save that lies. */}
                        <Button size="xs" onClick={() => saveEdit(v.id)} loading={saving}
                          disabled={!arrivedAt || (!!v.departedAt && !departedAt)}>
                          Save
                        </Button>
                        <ActionIcon variant="subtle" aria-label="Cancel edit" onClick={() => setEditing(null)}>
                          <IconX size={16} />
                        </ActionIcon>
                      </Group>
                    ) : (
                      <Group gap="xs" wrap="nowrap">
                        <ActionIcon variant="subtle" aria-label="Edit visit" onClick={() => startEdit(v)}>
                          <IconPencil size={16} />
                        </ActionIcon>
                        <ActionIcon variant="subtle" color="red" aria-label="Delete visit"
                          onClick={() => remove(v)} disabled={saving}>
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Group>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>
    </PageContainer>
  );
}
