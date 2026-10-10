"use client";
import { useState } from "react";
import { Badge, Group, Table, Text, TextInput, Title } from "@mantine/core";
import { formatGtinDisplay } from "../lib/gtin";
import { useLoad } from "../components/api";
import LoadError from "../components/LoadError";

interface ProvisionalRow {
  id: number;
  provisionalGtin13: string;
  name: string;
  status: "pending" | "approved" | "rejected" | "mapped_to_existing";
  resolvedToGtin13: string | null;
  reviewedAt: string | null;
}

/** /inventory/provisional-items — provisional parts the catalog approved or mapped to an existing item. */
export default function ProvisionalItemsPage() {
  const items = useLoad<ProvisionalRow[]>("/provisional-items");
  const [search, setSearch] = useState("");

  const resolved = (items.data ?? []).filter((i) => i.status === "approved" || i.status === "mapped_to_existing");
  const q = search.trim().toLowerCase();
  const visible = q
    ? resolved.filter((i) =>
        [i.name, formatGtinDisplay(i.provisionalGtin13), i.resolvedToGtin13 ? formatGtinDisplay(i.resolvedToGtin13) : ""]
          .some((s) => s.toLowerCase().includes(q)))
    : resolved;

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>Provisional Part Map</Title>
        {resolved.length > 0 && <Badge size="lg">{resolved.length} resolved</Badge>}
      </Group>
      <TextInput placeholder="Search name, provisional #, or resolved to…" value={search} onChange={(e) => setSearch(e.currentTarget.value)} mb="md" />
      {items.error && <LoadError what="provisional items" message={items.error} onRetry={items.reload} />}
      {items.data === null ? <Text c="dimmed">Loading…</Text>
        : visible.length === 0 ? <Text c="dimmed">{q ? `No results for "${search}".` : "No resolved provisional parts."}</Text>
        : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Provisional #</Table.Th>
                <Table.Th>Resolved to</Table.Th>
                <Table.Th>Reviewed</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visible.map((item) => (
                <Table.Tr key={item.id}>
                  <Table.Td>{item.name}</Table.Td>
                  <Table.Td ff="monospace">{formatGtinDisplay(item.provisionalGtin13)}</Table.Td>
                  <Table.Td ff="monospace">{item.resolvedToGtin13 ? formatGtinDisplay(item.resolvedToGtin13) : "—"}</Table.Td>
                  <Table.Td>{item.reviewedAt ? new Date(item.reviewedAt).toLocaleString() : "—"}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
    </>
  );
}
