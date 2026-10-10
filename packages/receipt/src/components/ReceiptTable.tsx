"use client";
import Link from "next/link";
import { Anchor, Badge, Table, Text } from "@mantine/core";
import { dollars, STATE_LABELS, type ReceiptListRow } from "./api";

/** One row per receipt, linking to its detail page. `paid` adds the reimbursement column. */
export default function ReceiptTable({ rows, paid = false }: { rows: ReceiptListRow[]; paid?: boolean }) {
  if (rows.length === 0) return <Text c="dimmed">No receipts.</Text>;
  return (
    <Table.ScrollContainer minWidth={560}>
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Uploaded</Table.Th>
            <Table.Th>Retailer</Table.Th>
            <Table.Th>Total</Table.Th>
            <Table.Th>State</Table.Th>
            {paid && <Table.Th>Reimbursement</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => (
            <Table.Tr key={r.id}>
              <Table.Td>
                <Anchor component={Link} href={`/receipts/${r.id}`}>{new Date(r.uploadedAt).toLocaleDateString()}</Anchor>
              </Table.Td>
              <Table.Td>{r.retailer ?? "—"}{r.isInKind && <Badge ml="xs" size="xs">Donation</Badge>}</Table.Td>
              <Table.Td>{dollars(r.receiptTotalCents)}</Table.Td>
              <Table.Td>{STATE_LABELS[r.state] ?? r.state}</Table.Td>
              {paid && (
                <Table.Td>
                  {r.reimbursement ? (r.reimbursement.paidOn ? `Paid on ${r.reimbursement.paidOn}` : "Not yet paid") : "—"}
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
