"use client";
import { useState } from "react";
import { Button, Code, Group, Select, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, useIsFinance, useLoad } from "../components/api";
import LoadError from "../components/LoadError";
import IncomeSubnav from "../components/IncomeSubnav";

interface ItemRow {
  variantId: string;
  title: string;
  sku: string | null;
  decision: "bucket" | "general" | "undecided";
  budgetOwnerId: number | null;
  budgetOwnerName: string | null;
  bucketIssue: string | null;
}

const GENERAL = "general";

interface Bucket {
  id: number;
  name: string;
}

/**
 * /income/items — every item the store has sold, and finance's decision for it: a budget-owner
 * bucket (its QuickBooks Class) or general income. Payouts with an undecided item's sale wait.
 */
export default function ItemsPage() {
  const items = useLoad<ItemRow[]>("/items");
  const isFinance = useIsFinance();
  const buckets = useLoad<Bucket[]>(isFinance ? "/api/budget-owners" : null);
  const [busy, setBusy] = useState<string | null>(null);

  /** A bucket id, null for general income, or "undecided" to remove the decision. */
  async function save(variantId: string, budgetOwnerId: number | null | "undecided") {
    setBusy(variantId);
    try {
      await api(`/items/${variantId}/category`, budgetOwnerId === "undecided"
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

  const options = [{ value: GENERAL, label: "General income" }, ...(buckets.data ?? []).map((b) => ({ value: String(b.id), label: b.name }))];
  const decisionLabel = (item: ItemRow) =>
    item.decision === "general" ? "General income" : item.decision === "bucket" ? (item.budgetOwnerName ?? `Bucket ${item.budgetOwnerId}`) : "Undecided";
  const selected = (item: ItemRow) =>
    item.decision === "general" ? GENERAL : item.budgetOwnerId === null ? null : String(item.budgetOwnerId);

  return (
    <>
      <IncomeSubnav />
      <Title order={3} mb="md">Item Categories</Title>
      <Text size="sm" c="dimmed" mb="md">
        Assign each item to a bucket or to general income. A payout with a sale of an undecided item, or of an item whose bucket has a problem, waits until finance fixes it.
      </Text>
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
                          placeholder="Undecided"
                          data={options}
                          value={selected(item)}
                          onChange={(v) => v && save(item.variantId, v === GENERAL ? null : Number(v))}
                          disabled={busy === item.variantId}
                        />
                        {item.decision !== "undecided" && (
                          <Button size="xs" variant="subtle" disabled={busy === item.variantId} onClick={() => save(item.variantId, "undecided")}>
                            Clear
                          </Button>
                        )}
                      </Group>
                    ) : decisionLabel(item)}
                    {item.bucketIssue && <Text size="xs" c="red">Bucket {item.bucketIssue}; its payouts wait</Text>}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
    </>
  );
}
