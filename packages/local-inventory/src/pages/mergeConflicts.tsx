"use client";
import { useEffect, useState } from "react";
import { Badge, Button, Group, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { formatGtinDisplay } from "../lib/gtin";
import { methodsFor, type QuantityMethod } from "../lib/mergeConflictMethods";
import { api, errorMessage, useLoad } from "../components/api";
import { LoadError } from "@checkin/component-ui";

interface ConflictRow {
  id: number;
  provisionalGtin13: string;
  realGtin13: string;
  conflictType: string;
  provisionalConversionFactor: number;
  existingConversionFactor: number;
  status: "pending" | "resolved";
  resolvedAt: string | null;
  resolution?: string | null;
}

/**
 * On-hand count of each provisional in `rows` still open, 0 when it has no org item. A GTIN whose
 * read failed is left out, so its options stay offered and the server decides.
 */
function useProvisionalStock(rows: ConflictRow[] | null): ReadonlyMap<string, number> {
  const [stock, setStock] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    const gtins = [...new Set((rows ?? []).filter((c) => c.status === "pending").map((c) => c.provisionalGtin13))];
    let live = true;
    Promise.all(
      gtins.map((g) =>
        api<{ gtin13: string; existingQuantity: number }[]>(`/org-items?q=${g}`).then(
          (items) => [g, items.find((i) => i.gtin13 === g)?.existingQuantity ?? 0] as const,
          () => null,
        ),
      ),
    ).then((pairs) => {
      if (live) setStock(new Map(pairs.filter((p) => p !== null)));
    });
    return () => { live = false; };
  }, [rows]);
  return stock;
}

/**
 * /inventory/merge-conflicts — provisional stock whose unit of measure differs
 * from the catalog item it resolved to. The counts are not summable as-is, so a
 * manager picks the quantity to keep. A provisional with no stock has no count to pick.
 */
export default function MergeConflictsPage() {
  const conflicts = useLoad<ConflictRow[]>("/inventory-merge-conflicts");
  const provisionalStock = useProvisionalStock(conflicts.data);
  const [busy, setBusy] = useState<number | null>(null);

  async function resolve(id: number, quantityMethod: QuantityMethod) {
    setBusy(id);
    try {
      await api(`/inventory-merge-conflicts/${id}/resolve`, { method: "PUT", body: JSON.stringify({ quantityMethod }) });
      notifications.show({ message: "Conflict resolved", color: "green" });
      conflicts.reload();
    } catch (err) {
      notifications.show({ message: errorMessage(err), color: "red", autoClose: false });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Title order={3} mb="md">Merge Conflicts</Title>
      {conflicts.error && <LoadError what="merge conflicts" message={conflicts.error} onRetry={conflicts.reload} />}
      {conflicts.data === null ? <Text c="dimmed">Loading…</Text>
        : conflicts.data.length === 0 ? <Text c="dimmed">No merge conflicts.</Text>
        : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Provisional</Table.Th>
                <Table.Th>Resolved to</Table.Th>
                <Table.Th>Units per receipt unit</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Resolve</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {conflicts.data.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td ff="monospace">{formatGtinDisplay(c.provisionalGtin13)}</Table.Td>
                  <Table.Td ff="monospace">{formatGtinDisplay(c.realGtin13)}</Table.Td>
                  <Table.Td>{c.provisionalConversionFactor} vs {c.existingConversionFactor}</Table.Td>
                  <Table.Td><Badge size="sm" color={c.status === "pending" ? "yellow" : "green"}>{c.status}</Badge></Table.Td>
                  <Table.Td>
                    {c.status === "pending" ? (
                      <Group gap={4} wrap="nowrap">
                        {methodsFor(provisionalStock.get(c.provisionalGtin13) ?? 1).map((m) => (
                          <Button key={m.value} size="xs" variant="light" loading={busy === c.id} onClick={() => resolve(c.id, m.value)}>{m.label}</Button>
                        ))}
                      </Group>
                    ) : (
                      <Text size="sm" c="dimmed">{c.resolvedAt ? new Date(c.resolvedAt).toLocaleString() : "—"}</Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
    </>
  );
}
