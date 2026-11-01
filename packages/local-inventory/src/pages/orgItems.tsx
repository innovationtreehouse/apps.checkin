"use client";
import { useState } from "react";
import {
  ActionIcon, Button, Group, Modal, NumberInput, Pagination, Select, Table, Text, TextInput, Title, Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconChevronDown, IconChevronUp, IconEdit, IconPlus, IconSelector, IconTrash } from "@tabler/icons-react";
import { formatGtinDisplay } from "../lib/gtin";
import { api, errorMessage, lastPage, PAGE_SIZE, useCanManage, useCatalogNames, useLoad } from "../components/api";
import { LoadError } from "@checkin/component-ui";

interface LocationRef { id: number; name: string }
interface OrgItemRow {
  id: number;
  gtin13: string;
  existingQuantity: number;
  desiredQuantity: number;
  locationId: number | null;
  backstockLocationId: number | null;
  location: LocationRef | null;
  backstockLocation: LocationRef | null;
}

const toId = (v: string | null) => (v ? Number(v) : null);

/** A row's editable values, in the form's types. */
const editableValues = (item: OrgItemRow | null) => ({
  existingQuantity: item?.existingQuantity ?? 0,
  desiredQuantity: item?.desiredQuantity ?? 0,
  locationId: item?.locationId ? String(item.locationId) : null,
  backstockLocationId: item?.backstockLocationId ? String(item.backstockLocationId) : null,
});
type EditableValues = ReturnType<typeof editableValues>;

interface ItemForm extends EditableValues {
  gtin13: string;
  /** The values when the form was loaded; a save sends only what differs, checked against these. */
  loaded: EditableValues;
}

/** The columns the org-items route can order by. */
type SortCol = "gtin13" | "location" | "backstock";
type SortDir = "asc" | "desc";
const TH_SORT_STYLE = { cursor: "pointer", userSelect: "none" } as const;

function SortHeader({ col, label, sortBy, sortDir, onSort }: {
  col: SortCol; label: string; sortBy: SortCol; sortDir: SortDir; onSort: (col: SortCol) => void;
}) {
  const active = sortBy === col;
  const Icon = !active ? IconSelector : sortDir === "asc" ? IconChevronUp : IconChevronDown;
  return (
    <Table.Th
      onClick={() => onSort(col)}
      style={TH_SORT_STYLE}
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <Group gap={4} wrap="nowrap">{label} <Icon size={14} /></Group>
    </Table.Th>
  );
}

function ItemsTable({ unlocated }: { unlocated: boolean }) {
  const canManage = useCanManage();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortCol>("gtin13");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [q] = useDebouncedValue(search.trim(), 300);
  const filter = new URLSearchParams({ ...(q ? { q } : {}), ...(unlocated ? { unlocated: "true" } : {}) });
  const order = new URLSearchParams({ sortBy, sortDir });
  const rows = useLoad<OrgItemRow[]>(`/org-items?${filter}&${order}&page=${page}&limit=${PAGE_SIZE}`, { keepPrevious: true });
  const count = useLoad<{ total: number }>(`/org-items/count?${filter}`, { keepPrevious: true });
  const locations = useLoad<LocationRef[]>("/locations");
  const names = useCatalogNames((rows.data ?? []).map((r) => r.gtin13));

  const [form, setForm] = useState<ItemForm | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<OrgItemRow | null>(null);
  const [saving, setSaving] = useState(false);

  const locationOptions = (locations.data ?? []).map((l) => ({ value: String(l.id), label: l.name }));
  const reload = () => { rows.reload(); count.reload(); };

  function toggleSort(col: SortCol) {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(col); setSortDir("asc"); }
    setPage(1);
  }
  const sortProps = { sortBy, sortDir, onSort: toggleSort };

  function openEdit(item: OrgItemRow | null) {
    setIsNew(item === null);
    const loaded = editableValues(item);
    setForm({ gtin13: item?.gtin13 ?? "", loaded, ...loaded });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    const { loaded } = form;
    const changes = {
      ...(form.existingQuantity !== loaded.existingQuantity && { existingQuantity: form.existingQuantity, expectedQuantity: loaded.existingQuantity }),
      ...(form.desiredQuantity !== loaded.desiredQuantity && { desiredQuantity: form.desiredQuantity, expectedDesiredQuantity: loaded.desiredQuantity }),
      ...(form.locationId !== loaded.locationId && { locationId: toId(form.locationId), expectedLocationId: toId(loaded.locationId) }),
      ...(form.backstockLocationId !== loaded.backstockLocationId && {
        backstockLocationId: toId(form.backstockLocationId),
        expectedBackstockLocationId: toId(loaded.backstockLocationId),
      }),
    };
    try {
      await (isNew
        ? api("/org-items", {
          method: "POST",
          body: JSON.stringify({
            gtin13: form.gtin13.replace(/\D/g, ""),
            existingQuantity: form.existingQuantity,
            desiredQuantity: form.desiredQuantity,
            locationId: toId(form.locationId),
            backstockLocationId: toId(form.backstockLocationId),
          }),
        })
        : api(`/org-items/${form.gtin13}`, { method: "PUT", body: JSON.stringify(changes) }));
      notifications.show({ message: isNew ? "Item added" : "Item updated", color: "green" });
      setForm(null);
      reload();
    } catch (err) {
      notifications.show({ message: errorMessage(err), color: "red", autoClose: false });
      if (!isNew) await reloadForm(form.gtin13);
    } finally {
      setSaving(false);
    }
  }

  /** Show what moved on the server in the open form and check against it, keeping the manager's other edits. */
  async function reloadForm(gtin13: string) {
    reload();
    const row = await api<OrgItemRow>(`/org-items/${gtin13}`).catch(() => null);
    if (!row) return;
    const fresh = editableValues(row);
    setForm((f) => {
      if (!f) return f;
      const latest = <K extends keyof EditableValues>(field: K) => (fresh[field] !== f.loaded[field] ? fresh[field] : f[field]);
      return {
        ...f,
        loaded: fresh,
        existingQuantity: latest("existingQuantity"),
        desiredQuantity: latest("desiredQuantity"),
        locationId: latest("locationId"),
        backstockLocationId: latest("backstockLocationId"),
      };
    });
  }

  async function remove() {
    if (!removeTarget) return;
    setSaving(true);
    try {
      await api(`/org-items/${removeTarget.gtin13}`, { method: "DELETE" });
      notifications.show({ message: "Item removed from organization inventory", color: "green" });
      setRemoveTarget(null);
      reload();
    } catch (err) {
      notifications.show({ message: errorMessage(err), color: "red", autoClose: false });
    } finally {
      setSaving(false);
    }
  }

  const total = count.data?.total ?? 0;
  const label = (gtin13: string) => names.get(gtin13) ?? "—";

  return (
    <>
      <Group justify="space-between" mb="md">
        <TextInput
          placeholder="Search by part number or location…"
          value={search}
          onChange={(e) => { setSearch(e.currentTarget.value); setPage(1); }}
          maw={400}
          style={{ flex: 1 }}
        />
        {canManage && !unlocated && (
          <Button leftSection={<IconPlus size={14} />} onClick={() => openEdit(null)}>Add item</Button>
        )}
      </Group>
      {rows.error && <LoadError what="inventory" message={rows.error} onRetry={reload} />}
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <SortHeader col="gtin13" label="Part No." {...sortProps} />
            <Table.Th>Have</Table.Th>
            <Table.Th>Desired</Table.Th>
            <SortHeader col="location" label="Location" {...sortProps} />
            <SortHeader col="backstock" label="Backstock" {...sortProps} />
            {canManage && <Table.Th w={90}>Actions</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.data === null ? (
            <Table.Tr><Table.Td colSpan={7}><Text c="dimmed">Loading…</Text></Table.Td></Table.Tr>
          ) : rows.data.length === 0 ? (
            <Table.Tr><Table.Td colSpan={7}><Text c="dimmed">No items found</Text></Table.Td></Table.Tr>
          ) : rows.data.map((item) => (
            <Table.Tr key={item.id}>
              <Table.Td>{label(item.gtin13)}</Table.Td>
              <Table.Td ff="monospace">{formatGtinDisplay(item.gtin13)}</Table.Td>
              <Table.Td>{item.existingQuantity}</Table.Td>
              <Table.Td>{item.desiredQuantity}</Table.Td>
              <Table.Td>{item.location?.name ?? "—"}</Table.Td>
              <Table.Td>{item.backstockLocation?.name ?? "—"}</Table.Td>
              {canManage && (
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <Tooltip label="Edit">
                      <ActionIcon variant="subtle" aria-label="Edit" onClick={() => openEdit(item)}><IconEdit size={16} /></ActionIcon>
                    </Tooltip>
                    <Tooltip label="Remove from organization inventory">
                      <ActionIcon variant="subtle" color="red" aria-label="Remove" onClick={() => setRemoveTarget(item)}><IconTrash size={16} /></ActionIcon>
                    </Tooltip>
                  </Group>
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Group justify="space-between" mt="md">
        <Text size="sm" c="dimmed">{total} item{total === 1 ? "" : "s"}</Text>
        <Pagination value={page} onChange={setPage} total={lastPage(total)} />
      </Group>

      <Modal
        opened={form !== null}
        onClose={() => setForm(null)}
        title={isNew ? "Add item" : `Edit: ${label(form?.gtin13 ?? "")} (${formatGtinDisplay(form?.gtin13 ?? "")})`}
        centered
      >
        {form && (
          <form onSubmit={save}>
            {isNew && (
              <TextInput label="GTIN-13" required value={form.gtin13} onChange={(e) => setForm({ ...form, gtin13: e.currentTarget.value })} mb="sm" />
            )}
            <NumberInput label="Have (existing quantity)" value={form.existingQuantity} onChange={(v) => setForm({ ...form, existingQuantity: Number(v) || 0 })} min={0} allowDecimal={false} mb="sm" />
            <NumberInput label="Desired quantity" value={form.desiredQuantity} onChange={(v) => setForm({ ...form, desiredQuantity: Number(v) || 0 })} min={0} allowDecimal={false} mb="sm" />
            <Select label="Location" data={locationOptions} value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} clearable mb="sm" />
            <Select label="Backstock location" data={locationOptions} value={form.backstockLocationId} onChange={(v) => setForm({ ...form, backstockLocationId: v })} clearable mb="md" />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit" loading={saving}>Save</Button>
            </Group>
          </form>
        )}
      </Modal>

      <Modal opened={removeTarget !== null} onClose={() => setRemoveTarget(null)} title="Remove from organization inventory" centered>
        <Text mb="lg">
          Remove <strong>{formatGtinDisplay(removeTarget?.gtin13 ?? "")}</strong> from organization inventory? Its quantities and locations are lost.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setRemoveTarget(null)}>Cancel</Button>
          <Button color="red" loading={saving} onClick={remove}>Remove</Button>
        </Group>
      </Modal>
    </>
  );
}

/** /inventory/org-items — on-hand stock by location. */
export default function OrgItemsPage() {
  return (
    <>
      <Title order={3} mb="md">Organization Inventory</Title>
      <ItemsTable unlocated={false} />
    </>
  );
}

/** /inventory/unlocated — items with no location set. */
export function UnlocatedItemsPage() {
  return (
    <>
      <Title order={3} mb="md">Needs a location</Title>
      <ItemsTable unlocated />
    </>
  );
}
