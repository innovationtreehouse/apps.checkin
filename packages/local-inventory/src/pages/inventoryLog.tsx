"use client";
import { useState } from "react";
import { Badge, Pagination, Table, Text, Title } from "@mantine/core";
import { formatGtinDisplay } from "../lib/gtin";
import { lastPage, PAGE_SIZE, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

interface LogRow {
  id: number;
  changedAt: string;
  changeType: string;
  gtin13: string;
  fieldChanged: string;
  valueBefore: string | null;
  valueAfter: string | null;
}

const FIELD_LABELS: Record<string, string> = {
  existingQuantity: "Existing Quantity",
  desiredQuantity: "Desired Quantity",
  locationId: "Location",
  backstockLocationId: "Backstock Location",
};

/** /inventory/inventory-log — every change to an org item's count, target or locations, newest first. */
export default function InventoryLogPage() {
  const [page, setPage] = useState(1);
  const rows = useLoad<LogRow[]>(`/inventory-log?page=${page}&limit=${PAGE_SIZE}`);
  const count = useLoad<{ total: number }>("/inventory-log/count");
  return (
    <>
      <Title order={3} mb="md">Inventory log</Title>
      {rows.error ? <LoadError what="the inventory log" message={rows.error} onRetry={rows.reload} />
        : rows.data === null ? <Text c="dimmed">Loading…</Text>
          : rows.data.length === 0 ? <Text c="dimmed">No log entries yet.</Text>
            : (
              <>
                <LogTable rows={rows.data} />
                <Pagination mt="md" value={page} onChange={setPage} total={lastPage(count.data?.total ?? 0)} />
              </>
            )}
    </>
  );
}

function LogTable({ rows }: { rows: LogRow[] }) {
  return (
    <Table striped highlightOnHover withTableBorder>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>When</Table.Th><Table.Th>Type</Table.Th><Table.Th>Part No.</Table.Th>
          <Table.Th>Field</Table.Th><Table.Th>Before</Table.Th><Table.Th>After</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((entry) => (
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
  );
}
