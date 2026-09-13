"use client";
import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon, Badge, Button, Checkbox, Group, Modal, Pagination, Select,
  Stack, Table, Tabs, Text, TextInput, Title, Tooltip,
} from "@mantine/core";
import { useDisclosure, useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle, IconArchive, IconArchiveOff, IconChevronDown,
  IconChevronUp, IconEdit, IconLink, IconPlus, IconSelector,
} from "@tabler/icons-react";
import { formatItemId } from "../lib/gtin";
import { api, useCanManage } from "./api";
import { USAGE_BEHAVIORS } from "./viewTypes";
import type { CategoryRow, ItemRow, ItemReferenceRow, ReferenceConflictRow, SubcategoryRow, UsageBehavior } from "./viewTypes";
import ItemReferencesModal from "./ItemReferencesModal";

// Items use real server pagination: one PAGE_SIZE page of rows plus a separate
// count endpoint for the total (a scalar total can't ride the list's model-bag
// response — the stripper drops non-model keys, design §7 — so it rides the
// synthetic CatalogItemCount model). The other lists here are naturally bounded
// (a manager's learned references, unresolved conflicts), so they pull one
// capped page.
const PAGE_SIZE = 50;
const PAGE_LIMIT = 200;
const EMPTY_FORM = { name: "", categoryId: "", subcategoryId: "", usageBehavior: "" as UsageBehavior | "" };
const THEAD_STYLE = { position: "sticky" as const, top: 0, background: "var(--mantine-color-body)", zIndex: 1 };

// ── Associations Tab ──────────────────────────────────────────────────────────
function ReferencesTab() {
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [sortBy, setSortBy] = useState<"manufacturer" | "retailer" | "item">("manufacturer");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [showArchived, setShowArchived] = useState(false);
  const [refs, setRefs] = useState<ItemReferenceRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (q: string, sb: string, sd: string, sa: boolean) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: "1", limit: String(PAGE_LIMIT), sortBy: sb, sortDir: sd });
      if (q) params.set("q", q);
      if (sa) params.set("showArchived", "true");
      setRefs(await api<ItemReferenceRow[]>(`/item-references?${params}`));
    } catch (e) { console.error("[GlobalInventoryClient] failed to load item references", e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(debouncedSearch, sortBy, sortDir, showArchived); }, [load, debouncedSearch, sortBy, sortDir, showArchived]);

  function toggleSort(col: "manufacturer" | "retailer" | "item") {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(col); setSortDir("asc"); }
  }

  function SortIcon({ col }: { col: string }) {
    if (sortBy !== col) return <IconSelector size={14} />;
    return sortDir === "asc" ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />;
  }

  async function handleArchive(id: number) {
    try {
      await api(`/item-references/${id}/archive`, { method: "POST" });
      await load(debouncedSearch, sortBy, sortDir, showArchived);
      notifications.show({ message: "Reference archived", color: "orange" });
    } catch (e) { notifications.show({ message: e instanceof Error ? e.message : "Error", color: "red" }); }
  }

  async function handleUnarchive(id: number) {
    try {
      await api(`/item-references/${id}/unarchive`, { method: "POST" });
      await load(debouncedSearch, sortBy, sortDir, showArchived);
      notifications.show({ message: "Reference unarchived", color: "green" });
    } catch (e) { notifications.show({ message: e instanceof Error ? e.message : "Error", color: "red" }); }
  }

  const thStyle = { cursor: "pointer", userSelect: "none" as const, whiteSpace: "nowrap" as const };

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-end">
        <TextInput placeholder="Filter by manufacturer, part #, description, or item…" value={search} onChange={(e) => setSearch(e.currentTarget.value)} maw={380} />
        <Checkbox label="Show archived references" checked={showArchived} onChange={(e) => setShowArchived(e.currentTarget.checked)} />
      </Group>

      {loading ? <Text c="dimmed">Loading…</Text> : refs.length === 0 ? (
        <Text c="dimmed">No references found.</Text>
      ) : (
        <Table striped highlightOnHover withTableBorder verticalSpacing="xs">
          <Table.Thead style={THEAD_STYLE}>
            <Table.Tr>
              <Table.Th onClick={() => toggleSort("item")} style={thStyle}><Group gap={4} wrap="nowrap">Item <SortIcon col="item" /></Group></Table.Th>
              <Table.Th onClick={() => toggleSort("manufacturer")} style={thStyle}><Group gap={4} wrap="nowrap">Manufacturer <SortIcon col="manufacturer" /></Group></Table.Th>
              <Table.Th onClick={() => toggleSort("retailer")} style={thStyle}><Group gap={4} wrap="nowrap">Retailer <SortIcon col="retailer" /></Group></Table.Th>
              <Table.Th>Key Value</Table.Th>
              <Table.Th>Conversion</Table.Th>
              <Table.Th w={100} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {refs.map((a) => (
              <Table.Tr key={a.id} c={a.archivedAt ? "red" : undefined}>
                <Table.Td><Text size="sm">{a.item?.name ?? "—"} <Text span size="xs" c={a.archivedAt ? "red.3" : "dimmed"} ff="monospace">({formatItemId(a.gtin13)})</Text></Text></Table.Td>
                <Table.Td>{a.manufacturer ?? <Text c={a.archivedAt ? "red.3" : "dimmed"} size="sm">—</Text>}</Table.Td>
                <Table.Td>{a.retailer ?? <Text c={a.archivedAt ? "red.3" : "dimmed"} size="sm">—</Text>}</Table.Td>
                <Table.Td><Text size="sm" ff={a.partNumber ? "monospace" : undefined}>{a.partNumber ?? a.descriptionNormalized ?? "—"}</Text></Table.Td>
                <Table.Td><Text size="sm">{a.conversionFactor}x{a.conversionVersion > 1 ? ` (v${a.conversionVersion})` : ""}</Text></Table.Td>
                <Table.Td>
                  {a.archivedAt ? (
                    <Tooltip label="Unarchive"><ActionIcon variant="subtle" color="green" onClick={() => handleUnarchive(a.id)}><IconArchiveOff size={16} /></ActionIcon></Tooltip>
                  ) : (
                    <Tooltip label="Archive"><ActionIcon variant="subtle" color="orange" onClick={() => handleArchive(a.id)}><IconArchive size={16} /></ActionIcon></Tooltip>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

// ── Conflicts Tab ─────────────────────────────────────────────────────────────
function ConflictsTab({ conflicts, onResolved }: { conflicts: ReferenceConflictRow[]; onResolved: () => void }) {
  const [resolving, setResolving] = useState(false);

  async function handleResolve(id: number, resolution: "keep_existing" | "use_proposed") {
    setResolving(true);
    try {
      await api(`/reference-conflicts/${id}/resolve`, { method: "PUT", body: JSON.stringify({ resolution }) });
      onResolved();
      notifications.show({ message: "Conflict resolved", color: "green" });
    } catch (e) { notifications.show({ message: e instanceof Error ? e.message : "Error", color: "red" }); }
    finally { setResolving(false); }
  }

  if (conflicts.length === 0) return <Text c="dimmed">No unresolved conflicts.</Text>;

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">These conflicts arose when a manual reference contradicted an existing learned mapping. Choose which item the mapping should point to going forward.</Text>
      <Table striped highlightOnHover withTableBorder verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Manufacturer</Table.Th>
            <Table.Th>Retailer</Table.Th>
            <Table.Th>Key Type</Table.Th>
            <Table.Th>Key Value</Table.Th>
            <Table.Th>Existing Item</Table.Th>
            <Table.Th>Proposed Item</Table.Th>
            <Table.Th w={220}>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {conflicts.map((c) => (
            <Table.Tr key={c.id}>
              <Table.Td>{c.manufacturer ?? <Text c="dimmed" size="sm">—</Text>}</Table.Td>
              <Table.Td>{c.retailer ?? <Text c="dimmed" size="sm">—</Text>}</Table.Td>
              <Table.Td>
                {c.retailer && c.partNumber ? <Badge variant="light" color="blue" size="sm">Retailer + Part #</Badge>
                  : c.manufacturer && c.partNumber ? <Badge variant="light" color="grape" size="sm">Mfg + Part #</Badge>
                  : c.manufacturer && c.description ? <Badge variant="light" color="grape" size="sm">Mfg + Descr</Badge>
                  : <Tooltip label="Cannot produce automatic matches"><IconAlertTriangle size={16} color="var(--mantine-color-yellow-6)" /></Tooltip>}
              </Table.Td>
              <Table.Td><Text size="sm" ff={c.partNumber ? "monospace" : undefined}>{c.partNumber ?? c.description ?? "—"}</Text></Table.Td>
              <Table.Td><Text size="sm" ff="monospace">{formatItemId(c.existingGtin13)}</Text></Table.Td>
              <Table.Td><Text size="sm" ff="monospace">{formatItemId(c.proposedGtin13)}</Text></Table.Td>
              <Table.Td>
                <Group gap={6} wrap="nowrap">
                  <Button size="xs" variant="light" loading={resolving} onClick={() => handleResolve(c.id, "keep_existing")}>Keep existing</Button>
                  <Button size="xs" variant="filled" color="blue" loading={resolving} onClick={() => handleResolve(c.id, "use_proposed")}>Use proposed</Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function GlobalInventoryClient() {
  const canEdit = useCanManage();

  const [items, setItems] = useState<ItemRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [sortBy, setSortBy] = useState<"id" | "name" | "category">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const [subcategories, setSubcategories] = useState<SubcategoryRow[]>([]);

  const [modalOpen, { open, close }] = useDisclosure(false);
  const [editItem, setEditItem] = useState<ItemRow | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<ItemRow | null>(null);
  const [archiveOpen, { open: openArchive, close: closeArchive }] = useDisclosure(false);
  const [archiving, setArchiving] = useState(false);
  const [refsTarget, setRefsTarget] = useState<ItemRow | null>(null);
  const [refsOpen, { open: openRefs, close: closeRefs }] = useDisclosure(false);

  const [conflicts, setConflicts] = useState<ReferenceConflictRow[]>([]);
  const [conflictsLoaded, setConflictsLoaded] = useState(false);

  const loadItems = useCallback(async (q: string, sb: string, sd: string, sa: boolean, p: number) => {
    const params = new URLSearchParams({ page: String(p), limit: String(PAGE_SIZE), sortBy: sb, sortDir: sd });
    const countParams = new URLSearchParams();
    if (q) { params.set("q", q); countParams.set("q", q); }
    if (sa) { params.set("includeArchived", "true"); countParams.set("includeArchived", "true"); }
    try {
      const [rows, count] = await Promise.all([
        api<ItemRow[]>(`/items?${params}`),
        api<{ total: number }>(`/items/count?${countParams}`),
      ]);
      setItems(rows);
      setTotal(count.total);
    } catch (e) { console.error("[GlobalInventoryClient] failed to load items", e); }
  }, []);

  // Filter/sort change → back to page 1. Prev/Next call loadItems directly.
  useEffect(() => { setPage(1); loadItems(debouncedSearch, sortBy, sortDir, showArchived, 1); }, [loadItems, debouncedSearch, sortBy, sortDir, showArchived]);

  function goToPage(p: number) {
    setPage(p);
    loadItems(debouncedSearch, sortBy, sortDir, showArchived, p);
  }
  useEffect(() => { api<CategoryRow[]>("/categories").then(setCategories).catch((e) => console.error("[GlobalInventoryClient] failed to load categories", e)); }, []);

  async function loadSubcategories(categoryId: string) {
    if (!categoryId) { setSubcategories([]); return; }
    try {
      setSubcategories(await api<SubcategoryRow[]>(`/subcategories?categoryId=${categoryId}`));
    } catch (e) { console.error("[GlobalInventoryClient] failed to load subcategories", e); }
  }

  const loadConflicts = useCallback(async () => {
    try {
      setConflicts(await api<ReferenceConflictRow[]>(`/reference-conflicts?page=1&limit=${PAGE_LIMIT}`));
      setConflictsLoaded(true);
    } catch (e) { console.error("[GlobalInventoryClient] failed to load reference conflicts", e); }
  }, []);

  function handleTabChange(value: string | null) {
    if (value === "conflicts" && !conflictsLoaded) loadConflicts();
  }

  function toggleSort(col: "id" | "name" | "category") {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(col); setSortDir("asc"); }
  }

  function SortIcon({ col }: { col: string }) {
    if (sortBy !== col) return <IconSelector size={14} />;
    return sortDir === "asc" ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />;
  }

  function openCreate() {
    setEditItem(null);
    setForm(EMPTY_FORM);
    setSubcategories([]);
    open();
  }

  function openEdit(item: ItemRow) {
    setEditItem(item);
    setForm({ name: item.name, categoryId: String(item.categoryId), subcategoryId: String(item.subcategoryId), usageBehavior: item.usageBehavior as UsageBehavior });
    open();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (editItem) {
        await api(`/items/${editItem.gtin13}`, { method: "PUT", body: JSON.stringify({ name: form.name, usageBehavior: form.usageBehavior || undefined }) });
        notifications.show({ message: "Item updated", color: "green" });
      } else {
        await api("/items", { method: "POST", body: JSON.stringify({ name: form.name, categoryId: parseInt(form.categoryId, 10), subcategoryId: parseInt(form.subcategoryId, 10), usageBehavior: form.usageBehavior }) });
        notifications.show({ message: "Item created", color: "green" });
      }
      close();
      await loadItems(debouncedSearch, sortBy, sortDir, showArchived, page);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : "Error", color: "red" });
    } finally { setSubmitting(false); }
  }

  async function handleArchive() {
    if (!archiveTarget) return;
    setArchiving(true);
    try {
      await api(`/items/${archiveTarget.gtin13}/archive`, { method: "POST" });
      closeArchive();
      await loadItems(debouncedSearch, sortBy, sortDir, showArchived, page);
      notifications.show({ message: "Item archived", color: "orange" });
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : "Error", color: "red" });
    } finally { setArchiving(false); }
  }

  async function handleUnarchive(gtin13: string) {
    try {
      await api(`/items/${gtin13}/unarchive`, { method: "POST" });
      await loadItems(debouncedSearch, sortBy, sortDir, showArchived, page);
      notifications.show({ message: "Item unarchived", color: "green" });
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : "Error", color: "red" });
    }
  }

  const categoryOptions = categories.map((c) => ({ value: String(c.id), label: `${c.letter} — ${c.name}` }));
  const subcategoryOptions = subcategories.map((s) => ({ value: String(s.id), label: `${String(s.number).padStart(2, "0")} — ${s.name}` }));
  const usageBehaviorOptions = USAGE_BEHAVIORS.map((v) => ({ value: v, label: v }));
  const colSpan = 5 + (canEdit ? 1 : 0) + (showArchived ? 1 : 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>Global Catalog</Title>
        {canEdit && <Button leftSection={<IconPlus size={16} />} onClick={openCreate}>Add Item</Button>}
      </Group>

      <Tabs defaultValue="catalog" onChange={handleTabChange}>
        <Tabs.List mb="md">
          <Tabs.Tab value="catalog">Global Catalog</Tabs.Tab>
          {canEdit && <Tabs.Tab value="associations">Learned References</Tabs.Tab>}
          {canEdit && (
            <Tabs.Tab value="conflicts" color={conflicts.length > 0 ? "red" : undefined}>
              Reference Conflicts
              {conflicts.length > 0 && <Badge variant="filled" color="red" ml={6}>{conflicts.length}</Badge>}
            </Tabs.Tab>
          )}
        </Tabs.List>

        <Tabs.Panel value="catalog">
          <Group mb="md" justify="space-between" align="flex-end">
            <TextInput placeholder="Search by name, ID, category, or subcategory…" value={search} onChange={(e) => setSearch(e.currentTarget.value)} maw={400} />
            <Checkbox label="Show archived parts" checked={showArchived} onChange={(e) => setShowArchived(e.currentTarget.checked)} />
          </Group>

          <Table striped highlightOnHover withTableBorder verticalSpacing="xs">
            <Table.Thead style={THEAD_STYLE}>
              <Table.Tr>
                <Table.Th onClick={() => toggleSort("name")} style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}><Group gap={4} wrap="nowrap">Name <SortIcon col="name" /></Group></Table.Th>
                <Table.Th onClick={() => toggleSort("id")} style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}><Group gap={4} wrap="nowrap">Part Number <SortIcon col="id" /></Group></Table.Th>
                <Table.Th onClick={() => toggleSort("category")} style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}><Group gap={4} wrap="nowrap">Category <SortIcon col="category" /></Group></Table.Th>
                <Table.Th>Subcategory</Table.Th>
                <Table.Th>Usage</Table.Th>
                {showArchived && <Table.Th>Archived</Table.Th>}
                {canEdit && <Table.Th w={120}>Actions</Table.Th>}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.length === 0 ? (
                <Table.Tr><Table.Td colSpan={colSpan}><Text c="dimmed">No items found</Text></Table.Td></Table.Tr>
              ) : items.map((item) => (
                <Table.Tr key={item.gtin13}>
                  <Table.Td>{item.name}</Table.Td>
                  <Table.Td ff="monospace">{formatItemId(item.gtin13)}</Table.Td>
                  <Table.Td>{item.category.name}</Table.Td>
                  <Table.Td>{item.subcategory.name}</Table.Td>
                  <Table.Td>{item.usageBehavior}</Table.Td>
                  {showArchived && <Table.Td>{item.archivedAt ? <Badge color="orange" variant="light" size="sm">Archived</Badge> : null}</Table.Td>}
                  {canEdit && (
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Tooltip label="View references"><ActionIcon variant="subtle" color="gray" onClick={() => { setRefsTarget(item); openRefs(); }}><IconLink size={16} /></ActionIcon></Tooltip>
                        <Tooltip label="Edit"><ActionIcon variant="subtle" onClick={() => openEdit(item)}><IconEdit size={16} /></ActionIcon></Tooltip>
                        {!item.archivedAt && <Tooltip label="Archive"><ActionIcon variant="subtle" color="orange" onClick={() => { setArchiveTarget(item); openArchive(); }}><IconArchive size={16} /></ActionIcon></Tooltip>}
                        {item.archivedAt && <Tooltip label="Unarchive"><ActionIcon variant="subtle" color="green" onClick={() => handleUnarchive(item.gtin13)}><IconArchiveOff size={16} /></ActionIcon></Tooltip>}
                      </Group>
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {totalPages > 1 && (
            <Group justify="space-between" mt="md">
              <Text size="sm" c="dimmed">{total} item{total === 1 ? "" : "s"}</Text>
              <Pagination value={page} onChange={goToPage} total={totalPages} />
            </Group>
          )}
        </Tabs.Panel>

        {canEdit && <Tabs.Panel value="associations"><ReferencesTab /></Tabs.Panel>}
        {canEdit && <Tabs.Panel value="conflicts"><ConflictsTab conflicts={conflicts} onResolved={loadConflicts} /></Tabs.Panel>}
      </Tabs>

      <Modal opened={modalOpen} onClose={close} title={editItem ? "Edit Item" : "Add Item"} centered>
        <form onSubmit={handleSubmit}>
          <TextInput label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} required mb="sm" data-autofocus />
          <Select label="Usage Behavior" data={usageBehaviorOptions} value={form.usageBehavior || null} onChange={(v) => setForm({ ...form, usageBehavior: (v as UsageBehavior) ?? "" })} placeholder="Select usage behavior" required mb="sm" />
          {!editItem && (
            <>
              <Select label="Category" data={categoryOptions} value={form.categoryId || null} onChange={(v) => { setForm({ ...form, categoryId: v ?? "", subcategoryId: "" }); loadSubcategories(v ?? ""); }} placeholder="Select category" required mb="sm" nothingFoundMessage="No categories — add them in Categories" />
              <Select label="Subcategory" data={subcategoryOptions} value={form.subcategoryId || null} onChange={(v) => setForm({ ...form, subcategoryId: v ?? "" })} placeholder={form.categoryId ? "Select subcategory" : "Select a category first"} required disabled={!form.categoryId} mb="md" nothingFoundMessage="No subcategories for this category" />
            </>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>Cancel</Button>
            <Button type="submit" loading={submitting}>{editItem ? "Save" : "Create"}</Button>
          </Group>
        </form>
      </Modal>

      <Modal opened={archiveOpen} onClose={closeArchive} title="Confirm Archive" centered>
        <Text mb="lg">Archive <strong>{archiveTarget?.name}</strong> ({archiveTarget && formatItemId(archiveTarget.gtin13)})? Archived parts will not appear in the catalog by default.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeArchive}>Cancel</Button>
          <Button color="orange" loading={archiving} onClick={handleArchive}>Archive</Button>
        </Group>
      </Modal>

      <ItemReferencesModal item={refsTarget} opened={refsOpen} onClose={closeRefs} canEdit={canEdit} />
    </>
  );
}
