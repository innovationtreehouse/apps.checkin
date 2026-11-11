"use client";
import { useState } from "react";
import { ActionIcon, Checkbox, Group, Stack, Table, Text, TextInput, Tooltip } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconArchive, IconArchiveOff } from "@tabler/icons-react";
import { errorMessage, LoadError, showError } from "@checkin/component-ui";
import { formatGtinDisplay } from "../lib/gtin";
import { api, useLoad } from "./api";
import { SortIcon, THEAD_STYLE } from "./sortableTable";
import type { ItemReferenceRow } from "./viewTypes";

// A manager's learned references are naturally bounded, so the list pulls one capped page.
const PAGE_LIMIT = 200;

/** The learned part-to-item references, archivable by an inventory manager. */
export default function LearnedReferencesClient() {
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [sortBy, setSortBy] = useState<"manufacturer" | "retailer" | "item">("manufacturer");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [showArchived, setShowArchived] = useState(false);

  const params = new URLSearchParams({ page: "1", limit: String(PAGE_LIMIT), sortBy, sortDir });
  if (debouncedSearch) params.set("q", debouncedSearch);
  if (showArchived) params.set("showArchived", "true");
  const { data: refs, error, reload } = useLoad<ItemReferenceRow[]>(`/item-references?${params}`, { keepPrevious: true });

  function toggleSort(col: "manufacturer" | "retailer" | "item") {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(col); setSortDir("asc"); }
  }

  async function handleArchive(id: number) {
    try {
      await api(`/item-references/${id}/archive`, { method: "POST" });
      notifications.show({ message: "Reference archived", color: "orange" });
    } catch (e) { showError(errorMessage(e)); }
  }

  async function handleUnarchive(id: number) {
    try {
      await api(`/item-references/${id}/unarchive`, { method: "POST" });
      notifications.show({ message: "Reference unarchived", color: "green" });
    } catch (e) { showError(errorMessage(e)); }
  }

  const thStyle = { cursor: "pointer", userSelect: "none" as const, whiteSpace: "nowrap" as const };

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-end">
        <TextInput aria-label="Filter references" placeholder="Filter by manufacturer, part #, description, or item…" value={search} onChange={(e) => setSearch(e.currentTarget.value)} maw={380} />
        <Checkbox label="Show archived references" checked={showArchived} onChange={(e) => setShowArchived(e.currentTarget.checked)} />
      </Group>

      {error ? (
        <LoadError what="references" message={error} onRetry={reload} />
      ) : refs === null ? <Text c="dimmed">Loading…</Text> : refs.length === 0 ? (
        <Text c="dimmed">No references found.</Text>
      ) : (
        <Table striped highlightOnHover withTableBorder verticalSpacing="xs">
          <Table.Thead style={THEAD_STYLE}>
            <Table.Tr>
              <Table.Th onClick={() => toggleSort("item")} style={thStyle}><Group gap={4} wrap="nowrap">Item <SortIcon active={sortBy === "item"} dir={sortDir} /></Group></Table.Th>
              <Table.Th onClick={() => toggleSort("manufacturer")} style={thStyle}><Group gap={4} wrap="nowrap">Manufacturer <SortIcon active={sortBy === "manufacturer"} dir={sortDir} /></Group></Table.Th>
              <Table.Th onClick={() => toggleSort("retailer")} style={thStyle}><Group gap={4} wrap="nowrap">Retailer <SortIcon active={sortBy === "retailer"} dir={sortDir} /></Group></Table.Th>
              <Table.Th>Key Value</Table.Th>
              <Table.Th>Conversion</Table.Th>
              <Table.Th w={100} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {refs.map((a) => (
              <Table.Tr key={a.id} c={a.archivedAt ? "red" : undefined}>
                <Table.Td><Text size="sm">{a.item?.name ?? "—"} <Text span size="xs" c={a.archivedAt ? "red.3" : "dimmed"} ff="monospace">({formatGtinDisplay(a.gtin13)})</Text></Text></Table.Td>
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
