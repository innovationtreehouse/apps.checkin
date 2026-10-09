"use client";
import { useEffect, useState } from "react";
import {
  ActionIcon, Badge, Button, Checkbox, Divider, Grid,
  Group, Modal, NumberInput, Paper, Stack, Text, TextInput, Title, Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconArchive, IconArchiveOff, IconEdit, IconPlus } from "@tabler/icons-react";
import { api, errorMessage, useCanManage } from "./api";
import LoadError from "./LoadError";
import type { CategoryRow, SubcategoryRow } from "./viewTypes";

function ListItem({ label, isArchived, isSelected, canEdit, onSelect, onEdit, onArchive, onUnarchive }: {
  label: string; isArchived?: boolean; isSelected?: boolean; canEdit: boolean;
  onSelect?: () => void; onEdit: () => void;
  onArchive?: () => void; onUnarchive?: () => void;
}) {
  return (
    <Group justify="space-between" px="sm" py={6} style={{ borderRadius: 6, cursor: onSelect ? "pointer" : undefined, background: isSelected ? "light-dark(var(--mantine-color-blue-1), var(--mantine-color-blue-8))" : undefined, opacity: isArchived ? 0.6 : 1 }} onClick={onSelect}>
      <Group gap="xs">
        <Text size="sm">{label}</Text>
        {isArchived && <Badge size="xs" color="gray" variant="outline">Archived</Badge>}
      </Group>
      {canEdit && (
        <Group gap={2}>
          <Tooltip label="Rename"><ActionIcon variant="subtle" size="sm" onClick={(e) => { e.stopPropagation(); onEdit(); }}><IconEdit size={14} /></ActionIcon></Tooltip>
          {onUnarchive && isArchived && <Tooltip label="Unarchive"><ActionIcon variant="subtle" color="green" size="sm" onClick={(e) => { e.stopPropagation(); onUnarchive(); }}><IconArchiveOff size={14} /></ActionIcon></Tooltip>}
          {onArchive && !isArchived && <Tooltip label="Archive"><ActionIcon variant="subtle" color="orange" size="sm" onClick={(e) => { e.stopPropagation(); onArchive(); }}><IconArchive size={14} /></ActionIcon></Tooltip>}
        </Group>
      )}
    </Group>
  );
}

export default function CategoriesClient() {
  const canEdit = useCanManage();
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [subcategories, setSubcategories] = useState<SubcategoryRow[]>([]);
  const [selectedCat, setSelectedCat] = useState<CategoryRow | null>(null);
  const [showArchivedCats, setShowArchivedCats] = useState(false);
  const [showArchivedSubs, setShowArchivedSubs] = useState(false);

  const [catModalOpen, { open: openCatModal, close: closeCatModal }] = useDisclosure(false);
  const [subModalOpen, { open: openSubModal, close: closeSubModal }] = useDisclosure(false);
  const [editCat, setEditCat] = useState<CategoryRow | null>(null);
  const [editSub, setEditSub] = useState<SubcategoryRow | null>(null);
  const [catForm, setCatForm] = useState({ name: "", letter: "" });
  const [subForm, setSubForm] = useState({ name: "", number: 0 });
  const [saving, setSaving] = useState(false);
  const [catError, setCatError] = useState<string | null>(null);
  const [subError, setSubError] = useState<string | null>(null);

  async function loadCategories(includeArchived: boolean) {
    try {
      setCategories(await api<CategoryRow[]>(`/categories${includeArchived ? "?includeArchived=true" : ""}`));
      setCatError(null);
    } catch (e) { setCatError(errorMessage(e)); }
  }

  useEffect(() => { loadCategories(false); }, []);

  async function loadSubcategories(catId: number, includeArchived: boolean) {
    const params = new URLSearchParams({ categoryId: String(catId) });
    if (includeArchived) params.set("includeArchived", "true");
    try {
      setSubcategories(await api<SubcategoryRow[]>(`/subcategories?${params}`));
      setSubError(null);
    } catch (e) { setSubError(errorMessage(e)); }
  }

  async function handleCatSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editCat) {
        const updated = await api<CategoryRow>(`/categories/${editCat.id}`, { method: "PUT", body: JSON.stringify(catForm) });
        if (selectedCat?.id === updated.id) setSelectedCat(updated);
        notifications.show({ message: "Category updated", color: "green" });
      } else {
        await api<CategoryRow>("/categories", { method: "POST", body: JSON.stringify(catForm) });
        notifications.show({ message: "Category created", color: "green" });
      }
      closeCatModal();
      await loadCategories(showArchivedCats);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : "Error", color: "red" });
    } finally { setSaving(false); }
  }

  async function handleSubSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedCat) return;
    setSaving(true);
    try {
      if (editSub) {
        await api<SubcategoryRow>(`/subcategories/${editSub.id}`, { method: "PUT", body: JSON.stringify({ name: subForm.name }) });
        notifications.show({ message: "Subcategory updated", color: "green" });
      } else {
        await api<SubcategoryRow>("/subcategories", { method: "POST", body: JSON.stringify({ name: subForm.name, number: subForm.number, categoryId: selectedCat.id }) });
        notifications.show({ message: "Subcategory created", color: "green" });
      }
      closeSubModal();
      await loadSubcategories(selectedCat.id, showArchivedSubs);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : "Error", color: "red" });
    } finally { setSaving(false); }
  }

  async function handleCatArchive(id: number) {
    try {
      await api(`/categories/${id}/archive`, { method: "POST" });
      if (selectedCat?.id === id) setSelectedCat(null);
      await loadCategories(showArchivedCats);
      notifications.show({ message: "Category archived", color: "orange" });
    } catch (err) { notifications.show({ message: err instanceof Error ? err.message : "Error", color: "red" }); }
  }

  async function handleCatUnarchive(id: number) {
    try {
      const updated = await api<CategoryRow>(`/categories/${id}/unarchive`, { method: "POST" });
      if (selectedCat?.id === id) setSelectedCat(updated);
      await loadCategories(showArchivedCats);
      notifications.show({ message: "Category unarchived", color: "green" });
    } catch (err) { notifications.show({ message: err instanceof Error ? err.message : "Error", color: "red" }); }
  }

  async function handleSubArchive(id: number) {
    if (!selectedCat) return;
    try {
      await api(`/subcategories/${id}/archive`, { method: "POST" });
      await loadSubcategories(selectedCat.id, showArchivedSubs);
      notifications.show({ message: "Subcategory archived", color: "orange" });
    } catch (err) { notifications.show({ message: err instanceof Error ? err.message : "Error", color: "red" }); }
  }

  async function handleSubUnarchive(id: number) {
    if (!selectedCat) return;
    try {
      await api(`/subcategories/${id}/unarchive`, { method: "POST" });
      await loadSubcategories(selectedCat.id, showArchivedSubs);
      notifications.show({ message: "Subcategory unarchived", color: "green" });
    } catch (err) { notifications.show({ message: err instanceof Error ? err.message : "Error", color: "red" }); }
  }

  async function handleSelectCat(cat: CategoryRow | null) {
    setSelectedCat(cat);
    if (cat) await loadSubcategories(cat.id, showArchivedSubs);
    else setSubcategories([]);
  }

  return (
    <>
      <Title order={3} mb="md">Categories &amp; Subcategories</Title>
      <Grid gutter="md" columns={10}>
        <Grid.Col span={4}>
          <Paper withBorder p="md" radius="md">
            <Group justify="space-between" mb="sm">
              <Text fw={600}>Categories</Text>
              <Group gap="sm">
                <Checkbox label="Show archived" size="xs" checked={showArchivedCats} onChange={async (e) => { setShowArchivedCats(e.currentTarget.checked); await loadCategories(e.currentTarget.checked); }} />
                {canEdit && <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => { setEditCat(null); setCatForm({ name: "", letter: "" }); openCatModal(); }}>Add</Button>}
              </Group>
            </Group>
            <Divider mb="sm" />
            {catError ? <LoadError what="categories" message={catError} onRetry={() => loadCategories(showArchivedCats)} />
              : categories.length === 0 ? <Text size="sm" c="dimmed">No categories yet</Text> : (
              <Stack gap={2}>
                {[...categories].sort((a, b) => a.letter.localeCompare(b.letter)).map((cat) => (
                  <ListItem key={cat.id} label={`${cat.letter} — ${cat.name}`} isArchived={!!cat.archivedAt} isSelected={selectedCat?.id === cat.id} canEdit={canEdit}
                    onSelect={() => handleSelectCat(selectedCat?.id === cat.id ? null : cat)}
                    onEdit={() => { setEditCat(cat); setCatForm({ name: cat.name, letter: cat.letter }); openCatModal(); }}
                    onArchive={() => handleCatArchive(cat.id)}
                    onUnarchive={() => handleCatUnarchive(cat.id)}
                  />
                ))}
              </Stack>
            )}
          </Paper>
        </Grid.Col>
        <Grid.Col span={6}>
          <Paper withBorder p="md" radius="md">
            <Group justify="space-between" mb="sm" wrap="nowrap">
              <Text fw={600} truncate style={{ flex: 1, minWidth: 0 }}>{selectedCat ? `Subcategories — ${selectedCat.name}` : "Subcategories"}</Text>
              <Group gap="sm">
                <Checkbox label="Show archived" size="xs" checked={showArchivedSubs} onChange={async (e) => { setShowArchivedSubs(e.currentTarget.checked); if (selectedCat) await loadSubcategories(selectedCat.id, e.currentTarget.checked); }} />
                {canEdit && <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => { setEditSub(null); setSubForm({ name: "", number: 0 }); openSubModal(); }} disabled={!selectedCat}>Add</Button>}
              </Group>
            </Group>
            <Divider mb="sm" />
            {!selectedCat ? <Text size="sm" c="dimmed">Select a category to manage its subcategories</Text>
              : subError ? <LoadError what="subcategories" message={subError} onRetry={() => loadSubcategories(selectedCat.id, showArchivedSubs)} />
              : subcategories.length === 0 ? <Text size="sm" c="dimmed">No subcategories yet</Text>
              : (
                <Stack gap={2}>
                  {subcategories.map((sub) => (
                    <ListItem key={sub.id} label={`${String(sub.number).padStart(2, "0")} — ${sub.name}`} isArchived={!!sub.archivedAt} canEdit={canEdit}
                      onEdit={() => { setEditSub(sub); setSubForm({ name: sub.name, number: sub.number }); openSubModal(); }}
                      onArchive={() => handleSubArchive(sub.id)}
                      onUnarchive={() => handleSubUnarchive(sub.id)}
                    />
                  ))}
                </Stack>
              )}
          </Paper>
        </Grid.Col>
      </Grid>

      <Modal opened={catModalOpen} onClose={closeCatModal} title={editCat ? "Edit Category" : "Add Category"} centered>
        <form onSubmit={handleCatSubmit}>
          <TextInput label="Name" value={catForm.name} onChange={(e) => setCatForm({ ...catForm, name: e.currentTarget.value })} required mb="sm" data-autofocus />
          <TextInput label="Letter (A–Z)" value={catForm.letter} onChange={(e) => setCatForm({ ...catForm, letter: e.currentTarget.value.toUpperCase().slice(0, 1) })} required maxLength={1} description="Single letter used in item IDs (unique among active categories)" mb="md" />
          <Group justify="flex-end">
            <Button variant="default" onClick={closeCatModal}>Cancel</Button>
            <Button type="submit" loading={saving}>{editCat ? "Save" : "Create"}</Button>
          </Group>
        </form>
      </Modal>

      <Modal opened={subModalOpen} onClose={closeSubModal} title={editSub ? "Edit Subcategory" : `Add Subcategory to ${selectedCat?.name}`} centered>
        <form onSubmit={handleSubSubmit}>
          <TextInput label="Name" value={subForm.name} onChange={(e) => setSubForm({ ...subForm, name: e.currentTarget.value })} required data-autofocus mb="sm" />
          <NumberInput label="Number (1–99)" value={subForm.number || ""} onChange={(v) => setSubForm({ ...subForm, number: Number(v) })} min={1} max={99} required disabled={!!editSub} description={editSub ? "Cannot change — used in item IDs" : "Unique among active subcategories in this category"} mb="md" />
          <Group justify="flex-end">
            <Button variant="default" onClick={closeSubModal}>Cancel</Button>
            <Button type="submit" loading={saving}>{editSub ? "Save" : "Create"}</Button>
          </Group>
        </form>
      </Modal>
    </>
  );
}
