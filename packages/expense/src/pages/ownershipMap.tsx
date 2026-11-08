"use client";
import { useState } from "react";
import { formatGtinDisplay } from "@checkin/gtin";
import { Button, Group, Select, Table, Text, Title } from "@mantine/core";
import { paged, send, useLoad, useRoles, type Bucket } from "../components/api";
import { CatalogPicker, LoadError, Pager, useUrlPage } from "@checkin/component-ui";

interface PartOwner {
  id: number;
  gtin13: string;
  ownerId: number;
}

interface CatalogItem {
  gtin13: string;
  name: string;
}

/** /expense/ownership-map — which budget-owner bucket owns each part; FINANCE edits it. */
export default function OwnershipMapPage() {
  const { isFinance } = useRoles();
  const [page, setPage] = useUrlPage();
  const map = useLoad<{ PartOwnerMap: PartOwner[]; Item?: CatalogItem[]; ExpenseBucketView: Bucket[] }>(paged("/ownership-map", page), { keepPrevious: true });
  const [gtin13, setGtin13] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);

  const buckets = map.data?.ExpenseBucketView ?? [];
  const nameOf = new Map(buckets.map((b) => [b.id, b.name]));
  const itemName = new Map((map.data?.Item ?? []).map((i) => [i.gtin13, i.name]));
  const options = buckets.filter((b) => !b.archivedAt).map((b) => ({ value: String(b.id), label: b.name }));

  return (
    <>
      <Title order={3} mb="xs">Part buckets</Title>
      <Text c="dimmed" mb="md">
        The bucket that pays for a part, by its barcode. A line for a mapped part goes to that bucket without
        Finance assigning one.
      </Text>
      {map.error && <LoadError what="the part buckets" message={map.error} onRetry={map.reload} />}
      <Table maw={640}>
        <Table.Thead><Table.Tr><Table.Th>Part</Table.Th><Table.Th>Bucket</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>
          {(map.data?.PartOwnerMap ?? []).map((p) => (
            <Table.Tr key={p.id}>
              <Table.Td>
                {itemName.get(p.gtin13) ?? formatGtinDisplay(p.gtin13)}
                {itemName.has(p.gtin13) && <Text size="xs" c="dimmed">{formatGtinDisplay(p.gtin13)}</Text>}
              </Table.Td>
              <Table.Td>{nameOf.get(p.ownerId) ?? `#${p.ownerId}`}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {map.data?.PartOwnerMap.length === 0 && <Text c="dimmed" mt="sm">No parts mapped yet.</Text>}
      {isFinance && (
        <Group mt="md" align="end">
          <CatalogPicker label="Part" value={gtin13} onChange={setGtin13} w={360} />
          <Select label="Bucket" data={options} value={owner} onChange={setOwner} searchable />
          <Button
            disabled={!gtin13 || !owner}
            onClick={async () => { if (await send("/ownership-map", "PUT", { gtin13, ownerId: Number(owner) }, "Mapping saved")) { setGtin13(null); map.reload(); } }}
          >Save</Button>
        </Group>
      )}
      <Pager page={page} onChange={setPage} rows={map.data?.PartOwnerMap} />
    </>
  );
}
