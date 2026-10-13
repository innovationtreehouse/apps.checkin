"use client";
import { useState } from "react";
import { Button, Group, Select, Table, Text, TextInput, Title } from "@mantine/core";
import { send, useLoad, useRoles, type Bucket } from "../components/api";
import LoadError from "../components/LoadError";
import ExpenseSubNav from "../components/ExpenseSubNav";

interface PartOwner {
  id: number;
  gtin13: string;
  ownerId: number;
}

/** /expense/ownership-map — which budget-owner bucket owns each part; FINANCE edits it. */
export default function OwnershipMapPage() {
  const { isFinance } = useRoles();
  const map = useLoad<{ PartOwnerMap: PartOwner[]; ExpenseBucketView: Bucket[] }>("/ownership-map");
  const [gtin13, setGtin13] = useState("");
  const [owner, setOwner] = useState<string | null>(null);

  const buckets = map.data?.ExpenseBucketView ?? [];
  const nameOf = new Map(buckets.map((b) => [b.id, b.name]));
  const options = buckets.filter((b) => !b.archivedAt).map((b) => ({ value: String(b.id), label: b.name }));

  return (
    <>
      <ExpenseSubNav current="/expense/ownership-map" />
      <Title order={3} mb="md">Ownership map</Title>
      {map.error && <LoadError what="the ownership map" message={map.error} onRetry={map.reload} />}
      <Table maw={640}>
        <Table.Thead><Table.Tr><Table.Th>GTIN</Table.Th><Table.Th>Bucket</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>
          {(map.data?.PartOwnerMap ?? []).map((p) => (
            <Table.Tr key={p.id}><Table.Td>{p.gtin13}</Table.Td><Table.Td>{nameOf.get(p.ownerId) ?? `#${p.ownerId}`}</Table.Td></Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {map.data?.PartOwnerMap.length === 0 && <Text c="dimmed" mt="sm">No parts mapped yet.</Text>}
      {isFinance && (
        <Group mt="md" align="end">
          <TextInput label="GTIN-13" value={gtin13} onChange={(e) => setGtin13(e.currentTarget.value)} />
          <Select label="Bucket" data={options} value={owner} onChange={setOwner} searchable />
          <Button
            disabled={!/^\d{13}$/.test(gtin13) || !owner}
            onClick={async () => { if (await send("/ownership-map", "PUT", { gtin13, ownerId: Number(owner) }, "Mapping saved")) { setGtin13(""); map.reload(); } }}
          >Save</Button>
        </Group>
      )}
    </>
  );
}
