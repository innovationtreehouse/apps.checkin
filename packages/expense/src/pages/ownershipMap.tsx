"use client";
import { useState } from "react";
import { formatGtinDisplay } from "@checkin/gtin";
import { Button, Group, Select, Table, Text, Title } from "@mantine/core";
import { paged, send, useLoad, useRoles, type Bucket } from "../components/api";
import { CatalogNamesUnavailable, CatalogPicker, LoadError, NO_CATALOG_NAMES, Pager, useUrlPage } from "@checkin/component-ui";

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
  const map = useLoad<{ PartOwnerMap: PartOwner[]; Item?: CatalogItem[]; ExpenseBucketView: Bucket[]; ExpenseCatalogNames?: { unavailable: boolean } }>(paged("/ownership-map", page), { keepPrevious: true });
  const [gtin13, setGtin13] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);

  const buckets = map.data?.ExpenseBucketView ?? [];
  const nameOf = new Map(buckets.map((b) => [b.id, b.name]));
  const itemName = new Map((map.data?.Item ?? []).map((i) => [i.gtin13, i.name]));
  const rows = map.data?.PartOwnerMap ?? [];
  // While the catalog can't be read, every unnamed row's name is unknown rather than absent.
  const failed = new Set(map.data?.ExpenseCatalogNames?.unavailable ? rows.map((p) => p.gtin13).filter((g) => !itemName.has(g)) : []);
  const options = buckets.filter((b) => !b.archivedAt).map((b) => ({ value: String(b.id), label: b.name }));

  return (
    <>
      <Title order={3} mb="xs">Part buckets</Title>
      <Text c="dimmed" mb="md">
        The bucket that pays for a part, by its barcode. A line for a mapped part goes to that bucket without
        Finance assigning one.
      </Text>
      {map.error && <LoadError what="the part buckets" message={map.error} onRetry={map.reload} />}
      <CatalogNamesUnavailable lookup={{ ...NO_CATALOG_NAMES, failed }} />
      <Table maw={640}>
        <Table.Thead><Table.Tr><Table.Th>Part</Table.Th><Table.Th>Bucket</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>
          {rows.map((p) => {
            const label = itemName.get(p.gtin13) ?? (failed.has(p.gtin13) ? "Name unavailable" : null);
            return (
              <Table.Tr key={p.id}>
                <Table.Td>
                  {label ?? formatGtinDisplay(p.gtin13)}
                  {label && <Text size="xs" c="dimmed">{formatGtinDisplay(p.gtin13)}</Text>}
                </Table.Td>
                <Table.Td>{nameOf.get(p.ownerId) ?? `#${p.ownerId}`}</Table.Td>
              </Table.Tr>
            );
          })}
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
