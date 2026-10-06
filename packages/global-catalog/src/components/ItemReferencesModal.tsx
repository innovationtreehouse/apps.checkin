"use client";
import { useState } from "react";
import {
  ActionIcon, Anchor, Button, Divider, Group, Modal, Table, Text, TextInput, Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArchive, IconCheck, IconEdit, IconPlus, IconX } from "@tabler/icons-react";
import { formatItemId } from "../lib/gtin";
import { api } from "./api";
import type { ItemRow, ItemReferenceRow } from "./viewTypes";

// conversionFactor is set by the reference matcher (S4), not the human UI — the
// create/update routes ignore it — so it is shown read-only here.
const EMPTY_REF = { partNumber: "", description: "", manufacturer: "", retailer: "", url: "" };

function RefRow({ ref: r, canEdit, onArchive, onEditingChange, onUpdated }: {
  ref: ItemReferenceRow;
  canEdit: boolean;
  onArchive: () => void;
  onEditingChange: (editing: boolean) => void;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    partNumber: r.partNumber ?? "",
    description: r.descriptionNormalized ?? "",
    manufacturer: r.manufacturer ?? "",
    retailer: r.retailer ?? "",
    url: r.url ?? "",
  });

  function enterEdit() { setEditing(true); onEditingChange(true); }
  function exitEdit() { setEditing(false); onEditingChange(false); }

  async function handleSave() {
    setSaving(true);
    try {
      await api(`/item-references/${r.id}`, {
        method: "PUT",
        body: JSON.stringify({
          partNumber: form.partNumber || undefined,
          description: form.description || undefined,
          manufacturer: form.manufacturer || undefined,
          retailer: form.retailer || undefined,
          url: form.url || undefined,
        }),
      });
      onUpdated();
      exitEdit();
      notifications.show({ message: "Reference updated", color: "green" });
    } catch (e) {
      notifications.show({ message: e instanceof Error ? e.message : "Error", color: "red" });
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <Table.Tr>
        <Table.Td><TextInput size="xs" value={form.partNumber} onChange={(e) => setForm({ ...form, partNumber: e.currentTarget.value })} /></Table.Td>
        <Table.Td><TextInput size="xs" value={form.description} onChange={(e) => setForm({ ...form, description: e.currentTarget.value })} /></Table.Td>
        <Table.Td><TextInput size="xs" value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.currentTarget.value })} /></Table.Td>
        <Table.Td><TextInput size="xs" value={form.retailer} onChange={(e) => setForm({ ...form, retailer: e.currentTarget.value })} /></Table.Td>
        <Table.Td><TextInput size="xs" value={form.url} onChange={(e) => setForm({ ...form, url: e.currentTarget.value })} /></Table.Td>
        <Table.Td>{r.conversionFactor}</Table.Td>
        <Table.Td>
          <Group gap={4}>
            <Tooltip label="Save"><ActionIcon variant="subtle" color="green" size="sm" loading={saving} onClick={handleSave}><IconCheck size={14} /></ActionIcon></Tooltip>
            <Tooltip label="Cancel"><ActionIcon variant="subtle" size="sm" onClick={() => { exitEdit(); setForm({ partNumber: r.partNumber ?? "", description: r.descriptionNormalized ?? "", manufacturer: r.manufacturer ?? "", retailer: r.retailer ?? "", url: r.url ?? "" }); }}><IconX size={14} /></ActionIcon></Tooltip>
          </Group>
        </Table.Td>
      </Table.Tr>
    );
  }

  return (
    <Table.Tr>
      <Table.Td>{r.partNumber ?? <Text c="dimmed" size="sm">—</Text>}</Table.Td>
      <Table.Td>{r.descriptionNormalized ?? <Text c="dimmed" size="sm">—</Text>}</Table.Td>
      <Table.Td>{r.manufacturer ?? <Text c="dimmed" size="sm">—</Text>}</Table.Td>
      <Table.Td>{r.retailer ?? <Text c="dimmed" size="sm">—</Text>}</Table.Td>
      <Table.Td>
        {r.url
          ? <Anchor href={r.url} target="_blank" rel="noopener noreferrer" size="sm" style={{ wordBreak: "break-all" }}>{r.url}</Anchor>
          : <Text c="dimmed" size="sm">—</Text>}
      </Table.Td>
      <Table.Td>{r.conversionFactor}</Table.Td>
      <Table.Td>
        {canEdit && (
          <Group gap={4}>
            <Tooltip label="Edit"><ActionIcon variant="subtle" size="sm" onClick={enterEdit}><IconEdit size={14} /></ActionIcon></Tooltip>
            <Tooltip label="Archive"><ActionIcon variant="subtle" color="orange" size="sm" onClick={onArchive}><IconArchive size={14} /></ActionIcon></Tooltip>
          </Group>
        )}
      </Table.Td>
    </Table.Tr>
  );
}

export default function ItemReferencesModal({ item, opened, onClose, canEdit }: {
  item: ItemRow | null;
  opened: boolean;
  onClose: () => void;
  canEdit: boolean;
}) {
  const [refs, setRefs] = useState<ItemReferenceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [addForm, setAddForm] = useState(EMPTY_REF);
  const [showAdd, setShowAdd] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingRows, setEditingRows] = useState<Set<number>>(new Set());

  async function loadRefs() {
    if (!item) return;
    setLoading(true);
    try {
      const data = await api<ItemReferenceRow[]>(`/item-references?gtin13=${encodeURIComponent(item.gtin13)}`);
      setRefs(data);
    } catch (e) { console.error("[ItemReferencesModal] failed to load item references", e); }
    finally { setLoading(false); }
  }

  const [wasOpened, setWasOpened] = useState(false);
  if (opened && !wasOpened) { setWasOpened(true); loadRefs(); }
  if (!opened && wasOpened) { setWasOpened(false); setRefs([]); setShowAdd(false); setAddForm(EMPTY_REF); setEditingRows(new Set()); }

  async function handleCreate() {
    if (!item) return;
    setCreating(true);
    try {
      await api(`/item-references`, {
        method: "POST",
        body: JSON.stringify({ gtin13: item.gtin13, partNumber: addForm.partNumber || undefined, description: addForm.description || undefined, manufacturer: addForm.manufacturer || undefined, retailer: addForm.retailer || undefined, url: addForm.url || undefined }),
      });
      await loadRefs();
      setAddForm(EMPTY_REF);
      setShowAdd(false);
      notifications.show({ message: "Reference added", color: "green" });
    } catch (e) {
      notifications.show({ message: e instanceof Error ? e.message : "Error", color: "red" });
    } finally { setCreating(false); }
  }

  async function handleArchive(id: number) {
    try {
      await api(`/item-references/${id}/archive`, { method: "POST" });
      await loadRefs();
      notifications.show({ message: "Reference archived", color: "orange" });
    } catch (e) {
      notifications.show({ message: e instanceof Error ? e.message : "Error", color: "red" });
    }
  }

  function handleEditingChange(id: number, editing: boolean) {
    setEditingRows((prev) => { const next = new Set(prev); if (editing) next.add(id); else next.delete(id); return next; });
  }

  const hasContent = addForm.partNumber.trim() || addForm.description.trim() || addForm.manufacturer.trim() || addForm.retailer.trim() || addForm.url.trim();

  function handleClose() {
    if (editingRows.size > 0 || (showAdd && hasContent)) {
      notifications.show({ message: "Save or cancel your changes before closing.", color: "yellow" });
      return;
    }
    onClose();
  }

  return (
    <Modal opened={opened} onClose={handleClose} title={item ? `References — ${item.name}` : "References"} size="xl" centered>
      {item && <Text size="sm" c="dimmed" ff="monospace" mb="md">{formatItemId(item.gtin13)}</Text>}
      {loading ? <Text c="dimmed">Loading…</Text> : refs.length === 0 && !showAdd ? (
        <Text size="sm" c="dimmed" mb="md">No references yet.</Text>
      ) : (
        <Table withTableBorder withColumnBorders mb="md" style={{ tableLayout: "fixed" }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w="16%">Part Number</Table.Th>
              <Table.Th w="18%">Description</Table.Th>
              <Table.Th w="16%">Manufacturer</Table.Th>
              <Table.Th w="16%">Retailer</Table.Th>
              <Table.Th>URL</Table.Th>
              <Table.Th w="10%">Conv. Factor</Table.Th>
              <Table.Th w={canEdit ? 80 : 0} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {refs.map((r) => (
              <RefRow key={r.id} ref={r} canEdit={canEdit} onArchive={() => handleArchive(r.id)} onEditingChange={(e) => handleEditingChange(r.id, e)} onUpdated={loadRefs} />
            ))}
            {showAdd && (
              <Table.Tr>
                <Table.Td><TextInput size="xs" placeholder="Part number" autoFocus value={addForm.partNumber} onChange={(e) => setAddForm({ ...addForm, partNumber: e.currentTarget.value })} /></Table.Td>
                <Table.Td><TextInput size="xs" placeholder="Description" value={addForm.description} onChange={(e) => setAddForm({ ...addForm, description: e.currentTarget.value })} /></Table.Td>
                <Table.Td><TextInput size="xs" placeholder="Manufacturer" value={addForm.manufacturer} onChange={(e) => setAddForm({ ...addForm, manufacturer: e.currentTarget.value })} /></Table.Td>
                <Table.Td><TextInput size="xs" placeholder="Retailer" value={addForm.retailer} onChange={(e) => setAddForm({ ...addForm, retailer: e.currentTarget.value })} /></Table.Td>
                <Table.Td><TextInput size="xs" placeholder="https://…" value={addForm.url} onChange={(e) => setAddForm({ ...addForm, url: e.currentTarget.value })} /></Table.Td>
                <Table.Td><Text c="dimmed" size="sm">auto</Text></Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    <Tooltip label="Save"><ActionIcon variant="subtle" color="green" size="sm" loading={creating} disabled={!hasContent} onClick={handleCreate}><IconCheck size={14} /></ActionIcon></Tooltip>
                    <Tooltip label="Cancel"><ActionIcon variant="subtle" size="sm" onClick={() => { setShowAdd(false); setAddForm(EMPTY_REF); }}><IconX size={14} /></ActionIcon></Tooltip>
                  </Group>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      )}
      <Divider mb="sm" />
      <Group justify="space-between">
        {canEdit && !showAdd ? (
          <Button size="xs" variant="subtle" leftSection={<IconPlus size={14} />} onClick={() => setShowAdd(true)}>Add reference</Button>
        ) : <span />}
        <Button variant="default" onClick={handleClose}>Close</Button>
      </Group>
    </Modal>
  );
}
