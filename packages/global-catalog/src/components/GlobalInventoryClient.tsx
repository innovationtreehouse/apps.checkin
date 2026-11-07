"use client";
import { useState } from "react";
import {
  ActionIcon, Badge, Button, Checkbox, Group, Modal, Pagination, Select,
  Table, Text, TextInput, Title, Tooltip,
} from "@mantine/core";
import { useDisclosure, useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconArchive, IconArchiveOff, IconEdit, IconLink, IconPlus } from "@tabler/icons-react";
import { formatGtinDisplay } from "../lib/gtin";
import { api, clampPage, lastPage, useCanManage, useLoad } from "./api";
import { errorMessage, LoadError, showError } from "@checkin/component-ui";
import { USAGE_BEHAVIORS } from "./viewTypes";
import type { CategoryRow, ItemRow, SubcategoryRow, UsageBehavior } from "./viewTypes";
import ItemReferencesModal from "./ItemReferencesModal";
import { SortIcon, THEAD_STYLE } from "./sortableTable";

// Items use real server pagination: one PAGE_SIZE page of rows plus a separate
// count endpoint for the total (a scalar total can't ride the list's model-bag
// response — the stripper drops non-model keys, design §7 — so it rides the
// synthetic CatalogItemCount model).
const PAGE_SIZE = 50;
const EMPTY_FORM = { name: "", categoryId: "", subcategoryId: "", usageBehavior: "" as UsageBehavior | "" };

export default function GlobalInventoryClient() {
  const canEdit = useCanManage();

  const [page, setPage] = useState(1);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [sortBy, setSortBy] = useState<"id" | "name" | "category">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const [modalOpen, { open, close }] = useDisclosure(false);
  const [editItem, setEditItem] = useState<ItemRow | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<ItemRow | null>(null);
  const [archiveOpen, { open: openArchive, close: closeArchive }] = useDisclosure(false);
  const [archiving, setArchiving] = useState(false);
  const [refsTarget, setRefsTarget] = useState<ItemRow | null>(null);
  const [refsOpen, { open: openRefs, close: closeRefs }] = useDisclosure(false);

  const itemFilter = new URLSearchParams();
  if (debouncedSearch) itemFilter.set("q", debouncedSearch);
  if (showArchived) itemFilter.set("includeArchived", "true");
  const countLoad = useLoad<{ total: number }>(`/items/count?${itemFilter}`, { keepPrevious: true });
  const total = countLoad.data?.total ?? 0;
  const shownPage = clampPage(page, total, PAGE_SIZE);
  const itemParams = new URLSearchParams({ page: String(shownPage), limit: String(PAGE_SIZE), sortBy, sortDir, ...Object.fromEntries(itemFilter) });
  const itemsLoad = useLoad<ItemRow[]>(`/items?${itemParams}`, { keepPrevious: true });
  const items = itemsLoad.data;
  const itemsError = itemsLoad.error ?? countLoad.error;

  const categoriesLoad = useLoad<CategoryRow[]>("/categories");
  const subcategoriesLoad = useLoad<SubcategoryRow[]>(modalOpen && !editItem && form.categoryId ? `/subcategories?categoryId=${form.categoryId}` : null);
  const optionsError = categoriesLoad.error ?? subcategoriesLoad.error;

  function toggleSort(col: "id" | "name" | "category") {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(col); setSortDir("asc"); }
    setPage(1);
  }

  function openCreate() {
    setEditItem(null);
    setForm(EMPTY_FORM);
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
    } catch (err) {
      showError(errorMessage(err));
    } finally { setSubmitting(false); }
  }

  async function handleArchive() {
    if (!archiveTarget) return;
    setArchiving(true);
    try {
      await api(`/items/${archiveTarget.gtin13}/archive`, { method: "POST" });
      closeArchive();
      notifications.show({ message: "Item archived", color: "orange" });
    } catch (err) {
      showError(errorMessage(err));
    } finally { setArchiving(false); }
  }

  async function handleUnarchive(gtin13: string) {
    try {
      await api(`/items/${gtin13}/unarchive`, { method: "POST" });
      notifications.show({ message: "Item unarchived", color: "green" });
    } catch (err) {
      showError(errorMessage(err));
    }
  }

  const categoryOptions = (categoriesLoad.data ?? []).map((c) => ({ value: String(c.id), label: `${c.letter} — ${c.name}` }));
  // A retry keeps the previous category's options in `data`, so only this category's can be picked.
  const subcategoryOptions = (subcategoriesLoad.data ?? []).filter((s) => String(s.categoryId) === form.categoryId).map((s) => ({ value: String(s.id), label: `${String(s.number).padStart(2, "0")} — ${s.name}` }));
  const usageBehaviorOptions = USAGE_BEHAVIORS.map((v) => ({ value: v, label: v }));
  const colSpan = 5 + (canEdit ? 1 : 0) + (showArchived ? 1 : 0);
  const totalPages = lastPage(total, PAGE_SIZE);

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>Global Catalog</Title>
        {canEdit && <Button leftSection={<IconPlus size={16} />} onClick={openCreate}>Add Item</Button>}
      </Group>

          <Group mb="md" justify="space-between" align="flex-end">
            <TextInput aria-label="Search items" placeholder="Search by name, ID, category, or subcategory…" value={search} onChange={(e) => { setSearch(e.currentTarget.value); setPage(1); }} maw={400} />
            <Checkbox label="Show archived parts" checked={showArchived} onChange={(e) => { setShowArchived(e.currentTarget.checked); setPage(1); }} />
          </Group>

          {itemsError && <LoadError what="items" message={itemsError} onRetry={() => { itemsLoad.reload(); countLoad.reload(); }} />}
          {!itemsError && <Table striped highlightOnHover withTableBorder verticalSpacing="xs">
            <Table.Thead style={THEAD_STYLE}>
              <Table.Tr>
                <Table.Th onClick={() => toggleSort("name")} style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}><Group gap={4} wrap="nowrap">Name <SortIcon active={sortBy === "name"} dir={sortDir} /></Group></Table.Th>
                <Table.Th onClick={() => toggleSort("id")} style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}><Group gap={4} wrap="nowrap">Part Number <SortIcon active={sortBy === "id"} dir={sortDir} /></Group></Table.Th>
                <Table.Th onClick={() => toggleSort("category")} style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}><Group gap={4} wrap="nowrap">Category <SortIcon active={sortBy === "category"} dir={sortDir} /></Group></Table.Th>
                <Table.Th>Subcategory</Table.Th>
                <Table.Th>Usage</Table.Th>
                {showArchived && <Table.Th>Archived</Table.Th>}
                {canEdit && <Table.Th w={120}>Actions</Table.Th>}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items === null ? (
                <Table.Tr><Table.Td colSpan={colSpan}><Text c="dimmed">Loading…</Text></Table.Td></Table.Tr>
              ) : items.length === 0 ? (
                <Table.Tr><Table.Td colSpan={colSpan}><Text c="dimmed">No items found</Text></Table.Td></Table.Tr>
              ) : items.map((item) => (
                <Table.Tr key={item.gtin13}>
                  <Table.Td>{item.name}</Table.Td>
                  <Table.Td ff="monospace">{formatGtinDisplay(item.gtin13)}</Table.Td>
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
          </Table>}
          {!itemsError && totalPages > 1 && (
            <Group justify="space-between" mt="md">
              <Text size="sm" c="dimmed">{total} item{total === 1 ? "" : "s"}</Text>
              <Pagination value={shownPage} onChange={setPage} total={totalPages} />
            </Group>
          )}

      <Modal opened={modalOpen} onClose={close} title={editItem ? "Edit Item" : "Add Item"} centered>
        <form onSubmit={handleSubmit}>
          {optionsError && <LoadError what="categories" message={optionsError} onRetry={() => { categoriesLoad.reload(); subcategoriesLoad.reload(); }} />}
          <TextInput label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} required mb="sm" data-autofocus />
          <Select label="Usage Behavior" data={usageBehaviorOptions} value={form.usageBehavior || null} onChange={(v) => setForm({ ...form, usageBehavior: (v as UsageBehavior) ?? "" })} placeholder="Select usage behavior" required mb="sm" />
          {!editItem && (
            <>
              <Select label="Category" data={categoryOptions} value={form.categoryId || null} onChange={(v) => { setForm({ ...form, categoryId: v ?? "", subcategoryId: "" }); }} placeholder="Select category" required mb="sm" nothingFoundMessage="No categories — add them in Categories" />
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
        <Text mb="lg">Archive <strong>{archiveTarget?.name}</strong> ({archiveTarget && formatGtinDisplay(archiveTarget.gtin13)})? Archived parts will not appear in the catalog by default.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeArchive}>Cancel</Button>
          <Button color="orange" loading={archiving} onClick={handleArchive}>Archive</Button>
        </Group>
      </Modal>

      <ItemReferencesModal item={refsTarget} opened={refsOpen} onClose={closeRefs} canEdit={canEdit} />
    </>
  );
}
