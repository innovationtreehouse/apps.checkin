"use client";
import { useState } from "react";
import { Button, Checkbox, Group, Select, Table, Text, Title } from "@mantine/core";
import { act, api, cents, useCanWrite, useLoad, useOwners } from "../components/api";
import LoadError from "../components/LoadError";
import type { GiftRow } from "./transactions";

/** /donations/unassigned — gifts that still need an owner or an organizational-level mark. */
export default function UnassignedPage() {
  const canWrite = useCanWrite();
  const gifts = useLoad<GiftRow[]>("/transactions/unassigned");
  const owners = useOwners();
  const [choice, setChoice] = useState<Record<number, string | null>>({});
  const [applyRule, setApplyRule] = useState<Record<number, boolean>>({});
  const ownerOptions = (owners.data ?? []).map((o) => ({ value: String(o.id), label: o.name }));

  const assign = (g: GiftRow) =>
    act(
      () => api(`/transactions/${g.id}/owner`, {
        method: "PATCH",
        body: JSON.stringify({ ownerId: Number(choice[g.id]), assignFutureMatchingComment: applyRule[g.id] ?? false }),
      }),
      "Owner assigned",
      gifts.reload,
    );
  const orgLevel = (g: GiftRow) =>
    act(() => api(`/transactions/${g.id}/organizational-level`, { method: "PATCH" }), "Marked organizational-level", gifts.reload);

  return (
    <>
      <Title order={3} mb="md">Unassigned gifts</Title>
      <Text size="sm" c="dimmed" mb="md">Both decisions are final once saved.</Text>
      {gifts.error && <LoadError what="unassigned gifts" message={gifts.error} onRetry={gifts.reload} />}
      {owners.error && <LoadError what="budget owners" message={owners.error} onRetry={owners.reload} />}
      {gifts.data?.length === 0 && <Text c="dimmed">Nothing waiting.</Text>}
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Donor</Table.Th><Table.Th>Company</Table.Th><Table.Th>Comment</Table.Th>
            <Table.Th>Donation</Table.Th><Table.Th>Match</Table.Th>{canWrite && <Table.Th>Owner</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(gifts.data ?? []).map((g) => (
            <Table.Tr key={g.id}>
              <Table.Td>{[g.donorFirstName, g.donorLastName].filter(Boolean).join(" ") || "—"}</Table.Td>
              <Table.Td>{g.companyName ?? "—"}</Table.Td>
              <Table.Td>{g.donorComment ?? "—"}</Table.Td>
              <Table.Td>{cents(g.donationAmountCents)}</Table.Td>
              <Table.Td>{cents(g.matchAmountCents)}</Table.Td>
              {canWrite && (
                <Table.Td>
                  <Group gap="xs" wrap="nowrap">
                    <Select size="xs" placeholder="Owner" data={ownerOptions} value={choice[g.id] ?? null}
                      onChange={(v) => setChoice((c) => ({ ...c, [g.id]: v }))} w={180} />
                    <Checkbox size="xs" label="Rule for this comment" checked={applyRule[g.id] ?? false}
                      onChange={(e) => setApplyRule((r) => ({ ...r, [g.id]: e.currentTarget.checked }))} />
                    <Button size="xs" disabled={!choice[g.id]} onClick={() => assign(g)}>Assign</Button>
                    <Button size="xs" variant="light" onClick={() => orgLevel(g)}>Org level</Button>
                  </Group>
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}
