"use client";

import { useState, useEffect, useCallback } from "react";
import { ActionIcon, Alert, Badge, Button, Group, Table, Text, TextInput, Title } from "@mantine/core";
import { IconPencil, IconTrash, IconX } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { PageContainer } from "@/components/ui/PageContainer";
import { useRequireRole } from "@/hooks/useRequireRole";
import { notifyNavRefresh } from "@/lib/nav-refresh";
import { formatDateOnly, toDatetimeLocal } from "@/lib/time";
import { useOrgTime } from '@/components/TimezoneProvider';
import { AttendanceTabs } from "../AttendanceTabs";
import { isCloseChoiceWarning, useCloseChoice } from "@/components/CloseChoiceDialog";

import { PageLoader } from "@/components/ui/PageLoader";
type Visit = { id: number; person?: { name: string }; event?: { name: string }; arrivedAt: string; departedAt?: string };

// A household lead corrects their household members' visits on the same
// trust-first terms as their own (design 1256_ATTENDANCE_CORRECTION_SURFACE.md
// §3) — the server flags significant changes to the board.
export default function HouseholdCheckins() {
  const { formatVisitRange, formatDateTime } = useOrgTime();
  const { ready, loading: authLoading, user } = useRequireRole([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const { ask: askCloseChoice, dialog: closeChoiceDialog } = useCloseChoice();
  const [filterDate, setFilterDate] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [arrivedAt, setArrived] = useState("");
  const [departedAt, setDeparted] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isLead = !!user?.householdLead;

  const load = useCallback(async () => {
    const res = await fetch(`/api/household/visits?date=${filterDate}`);
    if (res.ok) {
      const data = await res.json();
      setVisits(data.visits || []);
    }
  }, [filterDate]);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    (async () => { if (active) await load(); })();
    return () => { active = false; };
  }, [ready, load]);

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
    if (!window.confirm(`Delete this visit for ${v.person?.name || "this member"}? It will no longer count toward their hours.`)) return;
    void submit(v.id, { method: "DELETE" }, "Visit deleted.");
  };

  if (authLoading) return <PageLoader />;
  if (!ready) return null;

  return (
    <PageContainer>
      {closeChoiceDialog}
      <AttendanceTabs />
      <Group justify="space-between" align="center" wrap="wrap" mb="xs">
        <Title order={1}>Household Check-ins</Title>
        <TextInput
          type="date"
          label="Lookup Date"
          size="xs"
          value={filterDate || new Date().toISOString().split('T')[0]}
          onChange={(e) => setFilterDate(e.currentTarget.value)}
        />
      </Group>

      <Text size="sm" c="dimmed" mb="lg">
        {filterDate ? (
          <>Showing activity from <strong>{formatDateOnly(new Date(filterDate).getTime() - 7 * 24 * 60 * 60 * 1000)}</strong> to <strong>{formatDateOnly(new Date(filterDate).getTime() + 7 * 24 * 60 * 60 * 1000)}</strong></>
        ) : (
          <>Showing activity for the <strong>past 7 days</strong></>
        )}
      </Text>

      {error && <Alert color="red" mb="md">{error}</Alert>}

      {visits.length === 0 ? (
        <Text c="dimmed">No historical visits found for your household.</Text>
      ) : (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Household Member</Table.Th>
              <Table.Th>Event</Table.Th>
              <Table.Th>Arrived</Table.Th>
              <Table.Th>Duration</Table.Th>
              <Table.Th>Status</Table.Th>
              {isLead && <Table.Th />}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visits.map((v) => (
              <Table.Tr key={v.id}>
                <Table.Td><Text fw={600} c="blue">{v.person?.name || 'Unnamed household member'}</Text></Table.Td>
                <Table.Td>{v.event?.name || 'General Facility Visit'}</Table.Td>
                {editing === v.id ? (
                  <Table.Td colSpan={2}>
                    <Group gap="xs" wrap="nowrap">
                      <TextInput type="datetime-local" size="xs" value={arrivedAt}
                        onChange={(e) => setArrived(e.currentTarget.value)} aria-label="Arrival time" />
                      <TextInput type="datetime-local" size="xs" value={departedAt}
                        onChange={(e) => setDeparted(e.currentTarget.value)} aria-label="Departure time" />
                    </Group>
                  </Table.Td>
                ) : (
                  <>
                    <Table.Td>{formatDateTime(v.arrivedAt, { dateStyle: 'short', timeStyle: 'short' })}</Table.Td>
                    <Table.Td>{formatVisitRange(v.arrivedAt, v.departedAt)}</Table.Td>
                  </>
                )}
                <Table.Td>{!v.departedAt && <Badge color="yellow" variant="light">Active</Badge>}</Table.Td>
                {isLead && (
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
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </PageContainer>
  );
}
