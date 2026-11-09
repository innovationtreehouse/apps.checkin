"use client";
import { formatGtinDisplay, isValidGtin13 } from "@checkin/gtin";
import { useState } from "react";
import { ActionIcon, Badge, Button, Group, Select, Table, Text, Title, Tooltip } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { paged, send, useLoad, useRoles } from "../components/api";
import { CatalogPicker, LoadError, Pager, useUrlPage } from "@checkin/component-ui";
import { LINE_ACCOUNT_TYPES } from "@checkin/quickbooks/accountTypes";

interface Mapping {
  id: number;
  category: string;
  subcategory: string;
  partNumber: string;
  isDelayed: boolean | null;
  isCapital: boolean | null;
  qbAccount: string;
}
interface QbAccount {
  id: number;
  name: string;
  qbAccount: string;
}
/** One account from QuickBooks' live list, as the host's books-map route returns it. */
interface LiveAccount {
  id: string;
  accountType: string;
}

/** GET /api/catalog/categories and /subcategories rows; both lists omit archived entries. */
interface CategoryOption {
  id: number;
  name: string;
}
interface SubcategoryOption {
  id: number;
  name: string;
  categoryId: number;
}

/** "Any" (`*`), then the catalog names, plus the current value when the catalog doesn't list it. */
export function nameOptions(names: string[], current: string) {
  const unique = [...new Set(names)];
  if (current !== "*" && !unique.includes(current)) unique.unshift(current);
  return [{ value: "*", label: "Any" }, ...unique.map((n) => ({ value: n, label: n }))];
}

const TRI = [{ value: "any", label: "Any" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }];
const triOf = (v: string) => (v === "any" ? null : v === "yes");
const triLabel = (v: boolean | null) => (v === null ? "Any" : v ? "Yes" : "No");
/** A rule's part as shown: `*`, the part's short ID, or a stored value that no line's GTIN can ever equal. */
function RulePart({ partNumber }: { partNumber: string }) {
  if (partNumber === "*" || isValidGtin13(partNumber)) return <>{formatGtinDisplay(partNumber)}</>;
  return (
    <Group gap={4} wrap="nowrap">
      {partNumber}
      <Tooltip label="Not a part number from the catalog, so this rule never matches a line">
        <Badge color="red" variant="light" size="sm">never matches</Badge>
      </Tooltip>
    </Group>
  );
}

const EMPTY = { category: "*", subcategory: "*", partNumber: "*", isDelayed: "any", isCapital: "any", qbAccount: "" };

/** /expense/account-mapping — rules mapping a resolved line to one QuickBooks account (`*` matches anything). */
export default function AccountMappingPage() {
  const { isFinance } = useRoles();
  const [page, setPage] = useUrlPage();
  const mappings = useLoad<Mapping[]>(paged("/account-mapping", page), { keepPrevious: true });
  const accounts = useLoad<QbAccount[]>("/qb-accounts");
  const live = useLoad<LiveAccount[]>("/api/books-map/quickbooks-accounts");
  const categories = useLoad<CategoryOption[]>("/api/catalog/categories");
  const subcategories = useLoad<SubcategoryOption[]>("/api/catalog/subcategories");
  const [form, setForm] = useState(EMPTY);
  const categoryIds = new Set((categories.data ?? []).filter((c) => c.name === form.category).map((c) => c.id));
  const categoryOptions = nameOptions((categories.data ?? []).map((c) => c.name), form.category);
  const subcategoryOptions = form.category === "*"
    ? nameOptions([], "*")
    : nameOptions((subcategories.data ?? []).filter((s) => categoryIds.has(s.categoryId)).map((s) => s.name), form.subcategory);
  const typeOf = new Map((live.data ?? []).map((a) => [a.id, a.accountType]));
  const allowed: readonly string[] = form.isCapital === "yes" ? LINE_ACCOUNT_TYPES.donatedCapital : LINE_ACCOUNT_TYPES.donatedGoods;
  const options = (accounts.data ?? []).filter((a) => allowed.includes(typeOf.get(a.qbAccount) ?? "")).map((a) => ({ value: a.qbAccount, label: a.name }));

  async function add() {
    const body = { ...form, isDelayed: triOf(form.isDelayed), isCapital: triOf(form.isCapital) };
    if (await send("/account-mapping", "POST", body, "Rule added")) { setForm(EMPTY); mappings.reload(); }
  }

  return (
    <>
      <Title order={3} mb="xs">Account mapping</Title>
      <Text c="dimmed" mb="md">
        Rules that pick the QuickBooks account for an expense line: what the money was spent on. They do not pick
        the bucket, which says whose budget pays.
      </Text>
      {mappings.error && <LoadError what="account mapping" message={mappings.error} onRetry={mappings.reload} />}
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Category</Table.Th><Table.Th>Subcategory</Table.Th><Table.Th>Part No.</Table.Th>
            <Table.Th>Delayed</Table.Th><Table.Th>Capital</Table.Th><Table.Th>QB account</Table.Th><Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(mappings.data ?? []).map((m) => (
            <Table.Tr key={m.id}>
              <Table.Td>{m.category}</Table.Td><Table.Td>{m.subcategory}</Table.Td><Table.Td><RulePart partNumber={m.partNumber} /></Table.Td>
              <Table.Td>{triLabel(m.isDelayed)}</Table.Td><Table.Td>{triLabel(m.isCapital)}</Table.Td><Table.Td>{m.qbAccount}</Table.Td>
              <Table.Td>
                {isFinance && (
                  <ActionIcon variant="subtle" color="red" aria-label="Delete rule" onClick={async () => { if (await send(`/account-mapping/${m.id}`, "DELETE", {}, "Rule deleted")) mappings.reload(); }}>
                    <IconTrash size={16} />
                  </ActionIcon>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {mappings.data?.length === 0 && <Text c="dimmed" mt="sm">No rules yet.</Text>}
      {isFinance && (
        <Group mt="md" align="end">
          <Select
            label="Category"
            data={categoryOptions}
            value={form.category}
            onChange={(v) => setForm({ ...form, category: v ?? "*", subcategory: "*" })}
            searchable
            error={categories.error && `Couldn't load categories: ${categories.error}`}
            w={180}
          />
          <Select
            label="Subcategory"
            data={subcategoryOptions}
            value={form.subcategory}
            onChange={(v) => setForm({ ...form, subcategory: v ?? "*" })}
            disabled={form.category === "*"}
            searchable
            error={subcategories.error && `Couldn't load subcategories: ${subcategories.error}`}
            w={180}
          />
          <CatalogPicker
            label="Part No."
            placeholder="* (any part)"
            value={form.partNumber === "*" ? null : form.partNumber}
            onChange={(v) => setForm({ ...form, partNumber: v ?? "*" })}
            w={280}
          />
          <Select label="Delayed" data={TRI} value={form.isDelayed} onChange={(v) => setForm({ ...form, isDelayed: v ?? "any" })} w={90} />
          <Select label="Capital" data={TRI} value={form.isCapital} onChange={(v) => setForm({ ...form, isCapital: v ?? "any", qbAccount: "" })} w={90} />
          <Select
            label="QuickBooks account"
            data={options}
            value={form.qbAccount || null}
            onChange={(v) => setForm({ ...form, qbAccount: v ?? "" })}
            w={200}
          />
          <Button onClick={() => void add()} disabled={!form.qbAccount}>Add rule</Button>
        </Group>
      )}
      <Pager page={page} onChange={setPage} rows={mappings.data} />
    </>
  );
}
