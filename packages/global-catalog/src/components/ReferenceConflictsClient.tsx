"use client";
import { useState } from "react";
import { Badge, Button, Group, Stack, Table, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle } from "@tabler/icons-react";
import { errorMessage, LoadError, showError } from "@checkin/component-ui";
import { formatGtinDisplay } from "../lib/gtin";
import { api, useLoad } from "./api";
import type { ReferenceConflictRow } from "./viewTypes";

// Unresolved conflicts are naturally bounded, so the list pulls one capped page.
const PAGE_LIMIT = 200;

/** Conflicts between a manual reference and a learned mapping, resolved by an inventory manager. */
export default function ReferenceConflictsClient() {
  const { data: conflicts, error, reload: onRetry } = useLoad<ReferenceConflictRow[]>(`/reference-conflicts?page=1&limit=${PAGE_LIMIT}`);
  const [resolving, setResolving] = useState(false);

  async function handleResolve(c: ReferenceConflictRow, resolution: "keep_existing" | "use_proposed") {
    setResolving(true);
    try {
      await api(`/reference-conflicts/${c.id}/resolve`, { method: "PUT", body: JSON.stringify({ resolution, existingGtin13: c.itemReference.gtin13 }) });
      notifications.show({ message: "Conflict resolved", color: "green" });
    } catch (e) { showError(errorMessage(e)); }
    finally {
      setResolving(false);
      // A resolve can move the part under other open conflicts, and a refusal means this one is out of date.
      onRetry();
    }
  }

  if (error) return <LoadError what="reference conflicts" message={error} onRetry={onRetry} />;
  if (conflicts === null) return <Text c="dimmed">Loading…</Text>;
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
                {c.retailer && c.partNumber ? <Badge variant="light" color="blue" size="sm">Retailer + Store part #</Badge>
                  : c.manufacturer && c.partNumber ? <Badge variant="light" color="grape" size="sm">Mfg + Part #</Badge>
                  : c.manufacturer && c.description ? <Badge variant="light" color="grape" size="sm">Mfg + Descr</Badge>
                  : <Tooltip label="Cannot produce automatic matches"><IconAlertTriangle size={16} color="var(--mantine-color-yellow-6)" /></Tooltip>}
              </Table.Td>
              <Table.Td><Text size="sm" ff={c.partNumber ? "monospace" : undefined}>{c.partNumber ?? c.description ?? "—"}</Text></Table.Td>
              <Table.Td>
                <Text size="sm" ff="monospace">{formatGtinDisplay(c.itemReference.gtin13)}</Text>
                {c.itemReference.gtin13 !== c.existingGtin13 && (
                  <Text size="xs" c="orange">Out of date: raised against {formatGtinDisplay(c.existingGtin13)}. The part has moved since; this is where it is now.</Text>
                )}
              </Table.Td>
              <Table.Td><Text size="sm" ff="monospace">{formatGtinDisplay(c.proposedGtin13)}</Text></Table.Td>
              <Table.Td>
                {c.itemReference.gtin13 === c.proposedGtin13 ? (
                  <Stack gap={4} align="flex-start">
                    <Text size="xs">The part is already on the proposed item. Nothing is left to decide.</Text>
                    <Button size="xs" variant="light" loading={resolving} onClick={() => handleResolve(c, "use_proposed")}>Close</Button>
                  </Stack>
                ) : (
                  <Group gap={6} wrap="nowrap">
                    <Button size="xs" variant="light" loading={resolving} onClick={() => handleResolve(c, "keep_existing")}>Keep existing</Button>
                    <Button size="xs" variant="filled" color="blue" loading={resolving} onClick={() => handleResolve(c, "use_proposed")}>Use proposed</Button>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
