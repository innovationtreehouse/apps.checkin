"use client";
import { useState } from "react";
import {
  ActionIcon, Button, Divider, Group, Modal, Paper, Select, Stack, Text, TextInput, Title, Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowsExchange, IconEdit, IconPlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { api, errorMessage, useCanManage, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

interface LocationRow {
  id: number;
  name: string;
  _count?: { primaryItems?: number; backstockItems?: number };
}

const itemCount = (l: LocationRow) => (l._count?.primaryItems ?? 0) + (l._count?.backstockItems ?? 0);

type Dialog =
  | { kind: "name"; target: LocationRow | null }
  | { kind: "delete"; target: LocationRow }
  | { kind: "reassign"; target: LocationRow };

/** /inventory/locations — the shared list behind both the primary and backstock location fields. */
export default function LocationsPage() {
  const canManage = useCanManage();
  const locations = useLoad<LocationRow[]>("/locations");
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function open(next: Dialog) {
    setNameInput(next.target?.name ?? "");
    setTargetId(null);
    setDialog(next);
  }

  async function run(call: () => Promise<unknown>, message: string) {
    setSaving(true);
    try {
      await call();
      notifications.show({ message, color: "green" });
      setDialog(null);
      locations.reload();
    } catch (err) {
      notifications.show({ message: errorMessage(err), color: "red" });
    } finally {
      setSaving(false);
    }
  }

  function submitName(e: React.FormEvent) {
    e.preventDefault();
    if (dialog?.kind !== "name") return;
    const body = JSON.stringify({ name: nameInput });
    const target = dialog.target;
    void (target
      ? run(() => api(`/locations/${target.id}`, { method: "PUT", body }), "Location renamed")
      : run(() => api("/locations", { method: "POST", body }), "Location created"));
  }

  const acting = dialog && dialog.kind !== "name" ? dialog.target : null;
  const all = locations.data ?? [];
  const visible = all.filter((l) => l.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <Title order={3} mb="md">Locations</Title>
      <Text size="sm" c="dimmed" mb="md">Shared list used for both the primary and backstock location fields.</Text>
      {locations.error && <LoadError what="locations" message={locations.error} onRetry={locations.reload} />}

      <Paper withBorder p="md" radius="md" maw={520}>
        <Group justify="space-between" mb="sm">
          <Text fw={600}>Location list</Text>
          {canManage && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => open({ kind: "name", target: null })}>Add</Button>
          )}
        </Group>
        <TextInput
          placeholder="Filter locations…"
          leftSection={<IconSearch size={14} />}
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          mb="sm"
          size="xs"
        />
        <Divider mb="sm" />
        {locations.data === null ? <Text size="sm" c="dimmed">Loading…</Text>
          : visible.length === 0 ? <Text size="sm" c="dimmed">{all.length === 0 ? "No locations yet" : "No matches"}</Text>
          : (
            <Stack gap={2}>
              {visible.map((loc) => (
                <Group key={loc.id} justify="space-between" px="sm" py={6}>
                  <Text size="sm">{loc.name} <Text span c="dimmed" size="xs">({itemCount(loc)} items)</Text></Text>
                  {canManage && (
                    <Group gap={2}>
                      <Tooltip label="Rename">
                        <ActionIcon variant="subtle" size="sm" aria-label="Rename" onClick={() => open({ kind: "name", target: loc })}><IconEdit size={14} /></ActionIcon>
                      </Tooltip>
                      <Tooltip label="Move its items to another location">
                        <ActionIcon variant="subtle" size="sm" aria-label="Reassign" disabled={itemCount(loc) === 0} onClick={() => open({ kind: "reassign", target: loc })}>
                          <IconArrowsExchange size={14} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label={itemCount(loc) > 0 ? "Location is in use" : "Delete"}>
                        <span style={{ display: "inline-flex" }}>
                          <ActionIcon variant="subtle" color="red" size="sm" aria-label="Delete" disabled={itemCount(loc) > 0} onClick={() => open({ kind: "delete", target: loc })}>
                            <IconTrash size={14} />
                          </ActionIcon>
                        </span>
                      </Tooltip>
                    </Group>
                  )}
                </Group>
              ))}
            </Stack>
          )}
      </Paper>

      <Modal opened={dialog?.kind === "name"} onClose={() => setDialog(null)} title={dialog?.target ? "Rename location" : "Add location"} centered>
        <form onSubmit={submitName}>
          <TextInput label="Name" value={nameInput} onChange={(e) => setNameInput(e.currentTarget.value)} required mb="md" data-autofocus />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDialog(null)}>Cancel</Button>
            <Button type="submit" loading={saving}>{dialog?.target ? "Save" : "Create"}</Button>
          </Group>
        </form>
      </Modal>

      <Modal opened={dialog?.kind === "reassign"} onClose={() => setDialog(null)} title={`Move items out of ${acting?.name ?? ""}`} centered>
        <Select
          label="Move every item to"
          data={all.filter((l) => l.id !== acting?.id).map((l) => ({ value: String(l.id), label: l.name }))}
          value={targetId}
          onChange={setTargetId}
          mb="md"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDialog(null)}>Cancel</Button>
          <Button
            loading={saving}
            disabled={!targetId}
            onClick={() => acting && run(
              () => api(`/locations/${acting.id}/reassign`, { method: "POST", body: JSON.stringify({ targetLocationId: Number(targetId) }) }),
              "Items moved",
            )}
          >
            Move
          </Button>
        </Group>
      </Modal>

      <Modal opened={dialog?.kind === "delete"} onClose={() => setDialog(null)} title="Confirm delete" centered>
        <Text mb="lg">Delete location <strong>{acting?.name}</strong>?</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDialog(null)}>Cancel</Button>
          <Button color="red" loading={saving} onClick={() => acting && run(() => api(`/locations/${acting.id}`, { method: "DELETE" }), "Location deleted")}>
            Delete
          </Button>
        </Group>
      </Modal>
    </>
  );
}
