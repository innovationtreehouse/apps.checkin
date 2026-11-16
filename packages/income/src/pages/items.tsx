"use client";
import { useState } from "react";
import { Button, Code, Group, Select, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, notifyNavCounts, refusalMessage, useIsFinance, useLoad } from "../components/api";
import { InactivePickWarning, LoadError, QuickBooksListsRefresh } from "@checkin/component-ui";
import { LINE_ACCOUNT_TYPES } from "@checkin/quickbooks/accountTypes";

interface ItemRow {
  variantId: string;
  title: string;
  sku: string | null;
  decision: "bucket" | "general" | "undecided";
  budgetOwnerId: number | null;
  budgetOwnerName: string | null;
  bucketIssue: string | null;
  quickBooksAccountId: string | null;
}

interface AccountOption {
  id: string;
  name: string;
  accountType: string;
  active: boolean;
}

const SALE_TYPES: readonly string[] = LINE_ACCOUNT_TYPES.storeSale;

/** Picker choices: active accounts of a type a sale takes, plus the saved one marked when active but of another type; a saved inactive one shows as a warning. */
function accountChoices(options: AccountOption[] | null, saved: string | null) {
  return (options ?? [])
    .filter((o) => o.active && (SALE_TYPES.includes(o.accountType) || o.id === saved))
    .map((o) => ({ value: o.id, label: SALE_TYPES.includes(o.accountType) ? o.name : `${o.name} (wrong type: ${o.accountType})` }));
}

/** An item's account as a viewer who can't edit it reads it. */
function accountLabel(options: AccountOption[] | null, id: string) {
  const account = options?.find((o) => o.id === id);
  if (!account) return `QuickBooks id ${id}`;
  if (!account.active) return `${account.name} (inactive)`;
  return SALE_TYPES.includes(account.accountType) ? account.name : `${account.name} (wrong type: ${account.accountType})`;
}

const GENERAL = "general";

interface Bucket {
  id: number;
  name: string;
}

/**
 * /income/items — every item the store has sold, and finance's decision for it: a budget-owner
 * bucket (its QuickBooks Class) or general income, and the QuickBooks account its sales book to.
 * Payouts with a sale of an item missing either wait.
 */
export default function ItemsPage() {
  const items = useLoad<ItemRow[]>("/items");
  const isFinance = useIsFinance();
  const buckets = useLoad<Bucket[]>(isFinance ? "/api/budget-owners" : null);
  const accounts = useLoad<AccountOption[]>("/api/books-map/quickbooks-accounts");
  const [busy, setBusy] = useState<string | null>(null);

  /** A bucket id, null for general income, or "undecided" to remove the decision; `account` changes the item's account too. */
  async function save(variantId: string, budgetOwnerId: number | null | "undecided", account?: { quickBooksAccountId: string | null }) {
    setBusy(variantId);
    try {
      await api(`/items/${variantId}/category`, budgetOwnerId === "undecided"
        ? { method: "DELETE" }
        : { method: "PUT", body: JSON.stringify({ budgetOwnerId, ...account }) });
      notifications.show({ message: "Category saved; applies to deposits created from now on", color: "green" });
      items.reload();
      notifyNavCounts();
    } catch (err) {
      notifications.show({ message: refusalMessage(err), color: "red", autoClose: false });
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
      <Title order={3} mb="md">Item Categories</Title>
      <Text size="sm" c="dimmed" mb="md">
        Assign each item to a bucket or to general income, then pick the QuickBooks account its sales book to. A payout with a sale of an item missing either, or of an item whose bucket has a problem, waits until finance fixes it.
      </Text>
      {isFinance && <Group mb="sm"><QuickBooksListsRefresh /></Group>}
      {items.error && <LoadError what="items" message={items.error} onRetry={items.reload} />}
      {buckets.error && <Text size="sm" c="red" mb="sm">Couldn&apos;t load buckets: {buckets.error}</Text>}
      {accounts.error && <LoadError what="QuickBooks accounts" message={accounts.error} onRetry={accounts.reload} />}
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
                <Table.Th>QuickBooks account</Table.Th>
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
                  <Table.Td>
                    {isFinance ? (
                      <Select
                        size="xs"
                        aria-label={`QuickBooks account for ${item.title || item.variantId}`}
                        placeholder={item.decision === "undecided" ? "Choose a bucket first" : "Not set"}
                        searchable
                        clearable
                        data={accountChoices(accounts.data, item.quickBooksAccountId)}
                        value={item.quickBooksAccountId}
                        onChange={(v) => save(item.variantId, item.budgetOwnerId, { quickBooksAccountId: v })}
                        disabled={busy === item.variantId || item.decision === "undecided"}
                      />
                    ) : item.quickBooksAccountId ? accountLabel(accounts.data, item.quickBooksAccountId) : "Not set"}
                    {isFinance && <InactivePickWarning saved={item.quickBooksAccountId} options={accounts.data} />}
                    {item.decision !== "undecided" && !item.quickBooksAccountId && <Text size="xs" c="red">No account; its payouts wait</Text>}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
    </>
  );
}
