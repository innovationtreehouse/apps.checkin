"use client";
import { useState } from "react";
import { Button, Checkbox, Group, NumberInput, Paper, Select, Table, Text, Title } from "@mantine/core";
import { send, useBuckets, useLoad, useRoles } from "../components/api";
import { formatCents } from "@checkin/money";

interface DonatedLine {
  id: number;
  giftSource: string;
  giftId: number;
  description: string;
  quantity: number;
  costCents: number;
  acquisitionDate: string | null;
  budgetOwnerId: number;
}

interface Review {
  isCapital: boolean;
  years: number | "";
  owner: string | null;
}

/**
 * /expense/donated-capital — FINANCE's capital review of donated equipment: each gift line at or
 * over the capital thresholds becomes an asset in the register, or stays an in-kind expense. The
 * board sees the lines waiting.
 */
export default function DonatedCapitalPage() {
  const lines = useLoad<DonatedLine[]>("/donated-capital");
  const { isFinance } = useRoles();
  const buckets = useBuckets(isFinance);
  const [review, setReview] = useState<Record<number, Review>>({});

  const valueOf = (l: DonatedLine): Review => review[l.id] ?? { isCapital: true, years: "", owner: String(l.budgetOwnerId) };

  async function submit(l: DonatedLine) {
    const v = valueOf(l);
    const body = v.isCapital ? { isCapital: true, ownerId: Number(v.owner), depreciationYears: Number(v.years) } : { isCapital: false };
    if (await send(`/donated-capital/${l.id}/review`, "POST", body, "Capital review submitted")) lines.reload();
  }

  return (
    <>
      <Title order={3} mb="md">Donated equipment</Title>
      {lines.error && <Text c="red" size="sm">{lines.error}</Text>}
      {lines.data?.length === 0 && <Text c="dimmed">No donated lines are waiting on capital review.</Text>}
      {!!lines.data?.length && (
        <Paper withBorder p="sm">
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Gift</Table.Th><Table.Th>Item</Table.Th><Table.Th>Qty</Table.Th><Table.Th>Cost</Table.Th><Table.Th>Date</Table.Th>{isFinance && <Table.Th>Review</Table.Th>}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {lines.data.map((l) => {
                const v = valueOf(l);
                const set = (patch: Partial<Review>) => setReview({ ...review, [l.id]: { ...v, ...patch } });
                const incomplete = v.isCapital && (v.years === "" || !v.owner);
                return (
                  <Table.Tr key={l.id}>
                    <Table.Td>{l.giftSource} #{l.giftId}</Table.Td>
                    <Table.Td>{l.description}</Table.Td>
                    <Table.Td>{l.quantity}</Table.Td>
                    <Table.Td>{formatCents(l.costCents)}</Table.Td>
                    <Table.Td>{l.acquisitionDate ?? "—"}</Table.Td>
                    {isFinance && <Table.Td>
                      <Group gap="xs">
                        <Checkbox label="Asset" checked={v.isCapital} onChange={(e) => set({ isCapital: e.currentTarget.checked })} />
                        {v.isCapital && (
                          <>
                            <Select w={180} placeholder="Bucket" data={buckets} value={v.owner} onChange={(owner) => set({ owner })} />
                            <NumberInput w={100} placeholder="Years" min={1} value={v.years} onChange={(y) => set({ years: typeof y === "number" ? y : "" })} />
                          </>
                        )}
                        <Button size="compact-sm" disabled={incomplete} onClick={() => void submit(l)}>Submit</Button>
                      </Group>
                    </Table.Td>}
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Paper>
      )}
    </>
  );
}
