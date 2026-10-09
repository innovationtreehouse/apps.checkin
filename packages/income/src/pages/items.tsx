"use client";
import { useState } from "react";
import { Button, Code, Group, Select, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, useIsFinance, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

interface ItemRow {
  variantId: string;
  title: string;
  sku: string | null;
  budgetOwnerId: number | null;
  budgetOwnerName: string | null;
}

interface Bucket {
  id: number;
  name: string;
}

/**
 * /income/items — every item the store has sold, and the budget-owner bucket (QuickBooks
 * class) it books to. Unmapped items book at organization level.
 */
export default function ItemsPage() {
  const items = useLoad<ItemRow[]>("/items");
  const isFinance = useIsFinance();
  const buckets = useLoad<Bucket[]>(isFinance ? "/api/budget-owners" : null);
  const [busy, setBusy] = useState<string | null>(null);

  async function save(variantId: string, budgetOwnerId: number | null) {
    setBusy(variantId);
    try {
      await api(`/items/${variantId}/category`, budgetOwnerId === null
        ? { method: "DELETE" }
        : { method: "PUT", body: JSON.stringify({ budgetOwnerId }) });
      notifications.show({ message: "Category saved; applies to deposits created from now on", color: "green" });
      items.reload();
    } catch (err) {
      notifications.show({ message: errorMessage(err), color: "red" });
    } finally {
      setBusy(null);
    }
  }

  const options = (buckets.data ?? []).map((b) => ({ value: String(b.id), label: b.name }));

  return (
    <>
      <Title order={3} mb="md">Item Categories</Title>
      <Text size="sm" c="dimmed" mb="md">Unmapped items book at organization level.</Text>
      {items.error && <LoadError what="items" message={items.error} onRetry={items.reload} />}
      {buckets.error && <Text size="sm" c="red" mb="sm">Couldn&apos;t load budget-owner buckets: {buckets.error}</Text>}
      {items.data === null ? <Text c="dimmed">Loading…</Text>
        : items.data.length === 0 ? <Text c="dimmed">No items in the store mirror.</Text>
        : (
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Item</Table.Th>
                <Table.Th>SKU</Table.Th>
                <Table.Th>Variant</Table.Th>
                <Table.Th>Bucket</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.data.map((item) => (
                <Table.Tr key={item.variantId}>
                  <Table.Td>{item.title || "—"}</Table.Td>
                  <Table.Td>{item.sku ?? "—"}</Table.Td>
                  <Table.Td><Code>{item.variantId}</Code></Table.Td>
                  <Table.Td>
                    {isFinance ? (
                      <Group gap="xs" wrap="nowrap">
                        <Select
                          size="xs"
                          placeholder="Organization level"
                          data={options}
                          value={item.budgetOwnerId === null ? null : String(item.budgetOwnerId)}
                          onChange={(v) => v && save(item.variantId, Number(v))}
                          disabled={busy === item.variantId}
                        />
                        {item.budgetOwnerId !== null && (
                          <Button size="xs" variant="subtle" disabled={busy === item.variantId} onClick={() => save(item.variantId, null)}>
                            Clear
                          </Button>
                        )}
                      </Group>
                    ) : (item.budgetOwnerName ?? "Organization level")}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
    </>
  );
}
