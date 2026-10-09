"use client";
import { useState } from "react";
import { ActionIcon, Button, Group, Select, Table, Text, TextInput, Title } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { send, useLoad, useRoles } from "../components/api";
import LoadError from "../components/LoadError";

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

const TRI = [{ value: "any", label: "Any" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }];
const triOf = (v: string) => (v === "any" ? null : v === "yes");
const triLabel = (v: boolean | null) => (v === null ? "Any" : v ? "Yes" : "No");
const EMPTY = { category: "*", subcategory: "*", partNumber: "*", isDelayed: "any", isCapital: "any", qbAccount: "" };

/** /expense/account-mapping — rules mapping a resolved line to one QuickBooks account (`*` matches anything). */
export default function AccountMappingPage() {
  const { isFinance } = useRoles();
  const mappings = useLoad<Mapping[]>("/account-mapping");
  const accounts = useLoad<QbAccount[]>("/qb-accounts");
  const [form, setForm] = useState(EMPTY);

  async function add() {
    const body = { ...form, isDelayed: triOf(form.isDelayed), isCapital: triOf(form.isCapital) };
    if (await send("/account-mapping", "POST", body, "Rule added")) { setForm(EMPTY); mappings.reload(); }
  }

  return (
    <>
      <Title order={3} mb="md">Account mapping</Title>
      {mappings.error && <LoadError what="account mapping" message={mappings.error} onRetry={mappings.reload} />}
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Category</Table.Th><Table.Th>Subcategory</Table.Th><Table.Th>Part #</Table.Th>
            <Table.Th>Delayed</Table.Th><Table.Th>Capital</Table.Th><Table.Th>QB account</Table.Th><Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(mappings.data ?? []).map((m) => (
            <Table.Tr key={m.id}>
              <Table.Td>{m.category}</Table.Td><Table.Td>{m.subcategory}</Table.Td><Table.Td>{m.partNumber}</Table.Td>
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
          <TextInput label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.currentTarget.value })} w={120} />
          <TextInput label="Subcategory" value={form.subcategory} onChange={(e) => setForm({ ...form, subcategory: e.currentTarget.value })} w={120} />
          <TextInput label="Part #" value={form.partNumber} onChange={(e) => setForm({ ...form, partNumber: e.currentTarget.value })} w={120} />
          <Select label="Delayed" data={TRI} value={form.isDelayed} onChange={(v) => setForm({ ...form, isDelayed: v ?? "any" })} w={90} />
          <Select label="Capital" data={TRI} value={form.isCapital} onChange={(v) => setForm({ ...form, isCapital: v ?? "any" })} w={90} />
          <Select
            label="QB account"
            data={(accounts.data ?? []).map((a) => ({ value: a.qbAccount, label: a.name }))}
            value={form.qbAccount || null}
            onChange={(v) => setForm({ ...form, qbAccount: v ?? "" })}
            w={200}
          />
          <Button onClick={() => void add()} disabled={!form.qbAccount}>Add rule</Button>
        </Group>
      )}
    </>
  );
}
