"use client";
import { Table, Text, Title } from "@mantine/core";
import { useLoad } from "../components/api";
import { formatCents } from "@checkin/money";
import { LoadError } from "@checkin/component-ui";

interface BucketGiftLine { id: number; gtin13: string | null; description: string | null; quantity: number; valueCents: number | null }
interface BucketGift {
  id: number;
  source: "receipt" | "manual";
  budgetOwnerId: number;
  donationDate: string | null;
  totalValueCents: number | null;
  lines: BucketGiftLine[];
}

/** /programs-i-lead/in-kind-gifts — accepted gifts of goods in the buckets the viewer approves: what was given, its value and date. */
export default function InKindByBucketPage() {
  const gifts = useLoad<BucketGift[]>("/in-kind/by-bucket");

  return (
    <>
      <Title order={3} mb="md">In-kind gifts to your programs</Title>
      <Text size="sm" c="dimmed" mb="md">Goods given to the buckets you own or are treasurer for, once finance has accepted them. You see them; you do not approve them.</Text>
      {gifts.error && <LoadError what="in-kind gifts" message={gifts.error} onRetry={gifts.reload} />}
      {gifts.data?.length === 0 && <Text c="dimmed">No in-kind gifts in your buckets.</Text>}
      {!!gifts.data?.length && (
        <Table striped>
          <Table.Thead>
            <Table.Tr><Table.Th>Date given</Table.Th><Table.Th>What was given</Table.Th><Table.Th>Value</Table.Th></Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {gifts.data.map((g) => (
              <Table.Tr key={`${g.source}:${g.id}`}>
                <Table.Td>{g.donationDate ?? "—"}</Table.Td>
                <Table.Td>{g.lines.map((l) => `${l.quantity} × ${l.description ?? l.gtin13 ?? "item"}`).join(", ")}</Table.Td>
                <Table.Td>{g.totalValueCents === null ? "—" : formatCents(g.totalValueCents)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </>
  );
}
