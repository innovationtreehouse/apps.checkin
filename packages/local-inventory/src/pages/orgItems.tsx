"use client";
import { useState } from "react";
import {
  ActionIcon, Badge, Button, Group, Modal, NumberInput, Pagination, Select, Table, Tabs, Text, TextInput, Title, Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconEdit, IconPlus, IconTrash } from "@tabler/icons-react";
import { formatGtinDisplay } from "../lib/gtin";
import { api, errorMessage, lastPage, PAGE_SIZE, useCanManage, useCatalogNames, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

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
interface LogRow {
  id: number;
  changedAt: string;
  changeType: string;
  gtin13: string;
  fieldChanged: string;
  valueBefore: string | null;
  valueAfter: string | null;
}
interface ItemForm {
  gtin13: string;
  existingQuantity: number;
  desiredQuantity: number;
  locationId: string | null;
  backstockLocationId: string | null;
}

const FIELD_LABELS: Record<string, string> = {
  existingQuantity: "Existing Quantity",
  desiredQuantity: "Desired Quantity",
  locationId: "Location",
  backstockLocationId: "Backstock Location",
};

const toId = (v: string | null) => (v ? Number(v) : null);

function ItemsTable({ unlocated }: { unlocated: boolean }) {
  const canManage = useCanManage();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [q] = useDebouncedValue(search.trim(), 300);
  const filter = new URLSearchParams({ ...(q ? { q } : {}), ...(unlocated ? { unlocated: "true" } : {}) });
  const rows = useLoad<OrgItemRow[]>(`/org-items?${filter}&page=${page}&limit=${PAGE_SIZE}`);
  const count = useLoad<{ total: number }>(`/org-items/count?${filter}`);
  const locations = useLoad<LocationRef[]>("/locations");
  const names = useCatalogNames((rows.data ?? []).map((r) => r.gtin13));

  const [form, setForm] = useState<ItemForm | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<OrgItemRow | null>(null);
  const [saving, setSaving] = useState(false);

  const locationOptions = (locations.data ?? []).map((l) => ({ value: String(l.id), label: l.name }));
  const reload = () => { rows.reload(); count.reload(); };

  function openEdit(item: OrgItemRow | null) {
    setIsNew(item === null);
    setForm({
      gtin13: item?.gtin13 ?? "",
      existingQuantity: item?.existingQuantity ?? 0,
      desiredQuantity: item?.desiredQuantity ?? 0,
      locationId: item?.locationId ? String(item.locationId) : null,
      backstockLocationId: item?.backstockLocationId ? String(item.backstockLocationId) : null,
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    const body = {
      existingQuantity: form.existingQuantity,
      desiredQuantity: form.desiredQuantity,
      locationId: toId(form.locationId),
      backstockLocationId: toId(form.backstockLocationId),
    };
    try {
      await (isNew
        ? api("/org-items", { method: "POST", body: JSON.stringify({ gtin13: form.gtin13.replace(/\D/g, ""), ...body }) })
        : api(`/org-items/${form.gtin13}`, { method: "PUT", body: JSON.stringify(body) }));
      notifications.show({ message: isNew ? "Item added" : "Item updated", color: "green" });
      setForm(null);
      reload();
    } catch (err) {
      notifications.show({ message: errorMessage(err), color: "red" });
    } finally {
      setSaving(false);
    }
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
      notifications.show({ message: errorMessage(err), color: "red" });
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
            <Table.Th>Part No.</Table.Th>
            <Table.Th>Have</Table.Th>
            <Table.Th>Desired</Table.Th>
            <Table.Th>Location</Table.Th>
            <Table.Th>Backstock</Table.Th>
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

function InventoryLog() {
  const [page, setPage] = useState(1);
  const rows = useLoad<LogRow[]>(`/inventory-log?page=${page}&limit=${PAGE_SIZE}`);
  const count = useLoad<{ total: number }>("/inventory-log/count");
  if (rows.error) return <LoadError what="the inventory log" message={rows.error} onRetry={rows.reload} />;
  if (rows.data === null) return <Text c="dimmed">Loading…</Text>;
  if (rows.data.length === 0) return <Text c="dimmed">No log entries yet.</Text>;
  return (
    <>
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>When</Table.Th><Table.Th>Type</Table.Th><Table.Th>Part No.</Table.Th>
            <Table.Th>Field</Table.Th><Table.Th>Before</Table.Th><Table.Th>After</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.data.map((entry) => (
            <Table.Tr key={entry.id}>
              <Table.Td>{new Date(entry.changedAt).toLocaleString()}</Table.Td>
              <Table.Td><Badge color={entry.changeType === "manual" ? "gray" : "blue"} variant="light">{entry.changeType}</Badge></Table.Td>
              <Table.Td ff="monospace">{formatGtinDisplay(entry.gtin13)}</Table.Td>
              <Table.Td>{FIELD_LABELS[entry.fieldChanged] ?? entry.fieldChanged}</Table.Td>
              <Table.Td>{entry.valueBefore ?? "—"}</Table.Td>
              <Table.Td>{entry.valueAfter ?? "—"}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Pagination mt="md" value={page} onChange={setPage} total={lastPage(count.data?.total ?? 0)} />
    </>
  );
}

/** /inventory/org-items — on-hand stock by location, items without a location, and the change log. */
export default function OrgItemsPage() {
  const canManage = useCanManage();
  return (
    <>
      <Title order={3} mb="md">Organization Inventory</Title>
      <Tabs defaultValue="all" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="all">All Inventory</Tabs.Tab>
          {canManage && <Tabs.Tab value="attention" color="yellow">Needs a location</Tabs.Tab>}
          <Tabs.Tab value="log">Inventory Log</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="all"><ItemsTable unlocated={false} /></Tabs.Panel>
        {canManage && <Tabs.Panel value="attention"><ItemsTable unlocated /></Tabs.Panel>}
        <Tabs.Panel value="log"><InventoryLog /></Tabs.Panel>
      </Tabs>
    </>
  );
}
