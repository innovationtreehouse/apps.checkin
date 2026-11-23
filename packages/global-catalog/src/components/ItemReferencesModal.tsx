"use client";
import { useState } from "react";
import {
  ActionIcon, Anchor, Button, Divider, Group, Modal, NumberInput, Stack, Table, Text, Textarea, TextInput, Tooltip,
} from "@mantine/core";
import { IconArchive, IconCheck, IconEdit, IconPlus, IconScale, IconX } from "@tabler/icons-react";
import { formatGtinDisplay } from "../lib/gtin";
import { api, useLoad } from "./api";
import { errorMessage, LoadError, showError, showSuccess, showWarning } from "@checkin/component-ui";
import { PART_NUMBER_HINT, partNumberLabel, type ItemRow, type ItemReferenceRow } from "./viewTypes";

// conversionFactor is set by the reference matcher (S4), not the human UI — the
// create/update routes ignore it — so it is shown read-only here and changed only
// through a conversion challenge.
const EMPTY_REF = { partNumber: "", description: "", manufacturer: "", retailer: "", url: "" };

const REASON_MAX = 500;

function ChallengeModal({ row, onClose }: { row: ItemReferenceRow | null; onClose: () => void }) {
  const [proposed, setProposed] = useState<number | string>("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const factor = typeof proposed === "number" ? proposed : Number.NaN;
  const valid = row !== null && Number.isInteger(factor) && factor >= 1 && factor !== row.conversionFactor
    && reason.trim().length > 0 && reason.trim().length <= REASON_MAX;

  function close() { setProposed(""); setReason(""); onClose(); }

  async function handleSubmit() {
    if (!row || !valid) return;
    setSubmitting(true);
    try {
      await api(`/conversion-challenges`, {
        method: "POST",
        body: JSON.stringify({ itemReferenceId: row.id, proposedFactor: factor, reason: reason.trim() }),
      });
      showSuccess("Challenge filed for review");
      close();
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal opened={row !== null} onClose={close} title="Challenge conversion factor" centered>
      {row && (
        <Stack gap="sm">
          <TextInput label="Current factor" value={String(row.conversionFactor)} readOnly />
          <NumberInput label="Proposed factor" min={1} step={1} allowDecimal={false} allowNegative={false} value={proposed} onChange={setProposed} data-autofocus />
          <Textarea label="Reason" maxLength={REASON_MAX} autosize minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>Cancel</Button>
            <Button loading={submitting} disabled={!valid} onClick={handleSubmit}>File challenge</Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function RefRow({ row: r, canEdit, onArchive, onChallenge, onEditingChange }: {
  row: ItemReferenceRow;
  canEdit: boolean;
  onArchive: () => void;
  onChallenge: () => void;
  onEditingChange: (editing: boolean) => void;
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
      exitEdit();
      showSuccess("Reference updated");
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <Table.Tr>
        <Table.Td><TextInput size="xs" aria-label={partNumberLabel({ retailer: form.retailer || null, manufacturer: form.manufacturer || null })} value={form.partNumber} onChange={(e) => setForm({ ...form, partNumber: e.currentTarget.value })} /></Table.Td>
        <Table.Td><TextInput size="xs" aria-label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.currentTarget.value })} /></Table.Td>
        <Table.Td><TextInput size="xs" aria-label="Manufacturer" value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.currentTarget.value })} /></Table.Td>
        <Table.Td><TextInput size="xs" aria-label="Retailer" value={form.retailer} onChange={(e) => setForm({ ...form, retailer: e.currentTarget.value })} /></Table.Td>
        <Table.Td><TextInput size="xs" aria-label="URL" value={form.url} onChange={(e) => setForm({ ...form, url: e.currentTarget.value })} /></Table.Td>
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
      <Table.Td>
        {r.partNumber ? <><Text size="xs" c="dimmed">{partNumberLabel(r)}</Text>{r.partNumber}</> : <Text c="dimmed" size="sm">—</Text>}
      </Table.Td>
      <Table.Td>{r.descriptionNormalized ?? <Text c="dimmed" size="sm">—</Text>}</Table.Td>
      <Table.Td>{r.manufacturer ?? <Text c="dimmed" size="sm">—</Text>}</Table.Td>
      <Table.Td>{r.retailer ?? <Text c="dimmed" size="sm">—</Text>}</Table.Td>
      <Table.Td>
        {r.url
          ? <Anchor href={/^https?:\/\//i.test(r.url) ? r.url : undefined} target="_blank" rel="noopener noreferrer" size="sm" style={{ wordBreak: "break-all" }}>{r.url}</Anchor>
          : <Text c="dimmed" size="sm">—</Text>}
      </Table.Td>
      <Table.Td>{r.conversionFactor}</Table.Td>
      <Table.Td>
        {canEdit && (
          <Group gap={4}>
            <Tooltip label="Edit"><ActionIcon variant="subtle" size="sm" onClick={enterEdit}><IconEdit size={14} /></ActionIcon></Tooltip>
            <Tooltip label="Archive"><ActionIcon variant="subtle" color="orange" size="sm" onClick={onArchive}><IconArchive size={14} /></ActionIcon></Tooltip>
            {!r.archivedAt && (
              <Tooltip label="Challenge"><ActionIcon variant="subtle" color="blue" size="sm" aria-label="Challenge" onClick={onChallenge}><IconScale size={14} /></ActionIcon></Tooltip>
            )}
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
  const refsLoad = useLoad<ItemReferenceRow[]>(opened && item ? `/item-references?gtin13=${encodeURIComponent(item.gtin13)}` : null);
  const refs = refsLoad.data ?? [];
  const loading = refsLoad.data === null;
  const [addForm, setAddForm] = useState(EMPTY_REF);
  const [showAdd, setShowAdd] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingRows, setEditingRows] = useState<Set<number>>(new Set());
  const [challenging, setChallenging] = useState<ItemReferenceRow | null>(null);

  const [wasOpened, setWasOpened] = useState(false);
  if (opened && !wasOpened) setWasOpened(true);
  if (!opened && wasOpened) { setWasOpened(false); setShowAdd(false); setAddForm(EMPTY_REF); setEditingRows(new Set()); }

  async function handleCreate() {
    if (!item) return;
    setCreating(true);
    try {
      await api(`/item-references`, {
        method: "POST",
        body: JSON.stringify({ gtin13: item.gtin13, partNumber: addForm.partNumber || undefined, description: addForm.description || undefined, manufacturer: addForm.manufacturer || undefined, retailer: addForm.retailer || undefined, url: addForm.url || undefined }),
      });
      setAddForm(EMPTY_REF);
      setShowAdd(false);
      showSuccess("Reference added");
    } catch (e) {
      showError(errorMessage(e));
    } finally { setCreating(false); }
  }

  async function handleArchive(id: number) {
    try {
      await api(`/item-references/${id}/archive`, { method: "POST" });
      showSuccess("Reference archived");
    } catch (e) {
      showError(errorMessage(e));
    }
  }

  function handleEditingChange(id: number, editing: boolean) {
    setEditingRows((prev) => { const next = new Set(prev); if (editing) next.add(id); else next.delete(id); return next; });
  }

  const hasContent = addForm.partNumber.trim() || addForm.description.trim() || addForm.manufacturer.trim() || addForm.retailer.trim() || addForm.url.trim();

  function handleClose() {
    if (editingRows.size > 0 || (showAdd && hasContent)) {
      showWarning("Save or cancel your changes before closing.", { autoClose: 4000 });
      return;
    }
    onClose();
  }

  return (
    <Modal opened={opened} onClose={handleClose} title={item ? `References — ${item.name}` : "References"} size="xl" centered>
      {item && <Text size="sm" c="dimmed" ff="monospace" mb="md">{formatGtinDisplay(item.gtin13)}</Text>}
      {refsLoad.error ? <LoadError what="references" message={refsLoad.error} onRetry={refsLoad.reload} />
        : loading ? <Text c="dimmed">Loading…</Text> : refs.length === 0 && !showAdd ? (
        <Text size="sm" c="dimmed" mb="md">No references yet.</Text>
      ) : (
        <Table withTableBorder withColumnBorders mb="md" style={{ tableLayout: "fixed" }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w="16%"><Tooltip label={PART_NUMBER_HINT} multiline w={280}><span>Part #</span></Tooltip></Table.Th>
              <Table.Th w="18%">Description</Table.Th>
              <Table.Th w="16%">Manufacturer</Table.Th>
              <Table.Th w="16%">Retailer</Table.Th>
              <Table.Th>URL</Table.Th>
              <Table.Th w="10%">Conv. Factor</Table.Th>
              <Table.Th w={canEdit ? 100 : 0} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {refs.map((r) => (
              <RefRow key={r.id} row={r} canEdit={canEdit} onArchive={() => handleArchive(r.id)} onChallenge={() => setChallenging(r)} onEditingChange={(e) => handleEditingChange(r.id, e)} />
            ))}
            {showAdd && (
              <Table.Tr>
                <Table.Td><Tooltip label={PART_NUMBER_HINT} multiline w={280}><TextInput size="xs" aria-label="Part #" placeholder="Part #" autoFocus value={addForm.partNumber} onChange={(e) => setAddForm({ ...addForm, partNumber: e.currentTarget.value })} /></Tooltip></Table.Td>
                <Table.Td><TextInput size="xs" aria-label="Description" placeholder="Description" value={addForm.description} onChange={(e) => setAddForm({ ...addForm, description: e.currentTarget.value })} /></Table.Td>
                <Table.Td><TextInput size="xs" aria-label="Manufacturer" placeholder="Manufacturer" value={addForm.manufacturer} onChange={(e) => setAddForm({ ...addForm, manufacturer: e.currentTarget.value })} /></Table.Td>
                <Table.Td><TextInput size="xs" aria-label="Retailer" placeholder="Retailer" value={addForm.retailer} onChange={(e) => setAddForm({ ...addForm, retailer: e.currentTarget.value })} /></Table.Td>
                <Table.Td><TextInput size="xs" aria-label="URL" placeholder="https://…" value={addForm.url} onChange={(e) => setAddForm({ ...addForm, url: e.currentTarget.value })} /></Table.Td>
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
      <ChallengeModal row={challenging} onClose={() => setChallenging(null)} />
    </Modal>
  );
}
