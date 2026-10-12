"use client";
import { useState } from "react";
import { SegmentedControl, Table, Title } from "@mantine/core";
import { cents, ownerName, useLoad, useOwners } from "../components/api";
import LoadError from "../components/LoadError";

export interface GiftRow {
  id: number;
  transactionId: string;
  companyName: string | null;
  corporatePeerCampaign: string | null;
  donationAmountCents: number;
  matchAmountCents: number;
  donorFirstName: string | null;
  donorLastName: string | null;
  donorComment: string | null;
  ownerId: number | null;
  isOrganizationalLevel: boolean;
  donationDate: string | null;
}

/** /donations/transactions — every imported gift and who it belongs to. */
export default function TransactionsPage() {
  const [filter, setFilter] = useState("all");
  const gifts = useLoad<GiftRow[]>(filter === "all" ? "/transactions" : `/transactions?assigned=${filter}`);
  const owners = useOwners();

  return (
    <>
      <Title order={3} mb="md">Gifts</Title>
      <SegmentedControl mb="md" value={filter} onChange={setFilter}
        data={[{ value: "all", label: "All" }, { value: "true", label: "Assigned" }, { value: "false", label: "Unassigned" }]} />
      {gifts.error && <LoadError what="gifts" message={gifts.error} onRetry={gifts.reload} />}
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Date</Table.Th><Table.Th>Donor</Table.Th><Table.Th>Company</Table.Th>
            <Table.Th>Donation</Table.Th><Table.Th>Match</Table.Th><Table.Th>Owner</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(gifts.data ?? []).map((g) => (
            <Table.Tr key={g.id}>
              <Table.Td>{g.donationDate ?? "—"}</Table.Td>
              <Table.Td>{[g.donorFirstName, g.donorLastName].filter(Boolean).join(" ") || "—"}</Table.Td>
              <Table.Td>{g.companyName ?? "—"}</Table.Td>
              <Table.Td>{cents(g.donationAmountCents)}</Table.Td>
              <Table.Td>{cents(g.matchAmountCents)}</Table.Td>
              <Table.Td>{g.isOrganizationalLevel ? "Organizational level" : ownerName(owners.data, g.ownerId)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}
