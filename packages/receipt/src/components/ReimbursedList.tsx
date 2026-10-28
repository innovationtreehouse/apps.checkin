"use client";
import { Alert, Table, Text } from "@mantine/core";
import { dollars, latestOutcome, useLoad, type PurchaseOutcomeView } from "./api";

/** A reimbursement naming the caller that someone else uploaded, once finance has settled its receipt. */
export interface ReimbursedRow {
  id: string;
  state: string;
  retailer: string | null;
  receiptDate: string | null;
  receiptTotalCents: number | null;
  rejectionReason: string | null;
  reimbursement: { paidOn: string | null; statusUnavailable?: boolean };
  purchaseOutcome: PurchaseOutcomeView;
}

function status(r: ReimbursedRow): { text: string; color?: string } {
  if (r.state === "rejected") return { text: `Rejected: ${r.rejectionReason ?? "no reason was recorded"}`, color: "red" };
  const step = latestOutcome(r.purchaseOutcome);
  if (!step) return { text: "Receipt finalized" };
  const notes = step.notes.length ? `: ${step.notes.join("; ")}` : "";
  return { text: `${step.label}${notes}`, color: step.tone === "refused" ? "red" : step.tone === "done" ? "green" : undefined };
}

function paid(r: ReimbursedRow): string {
  if (r.state === "rejected") return "—";
  if (r.reimbursement.paidOn) return `Paid on ${r.reimbursement.paidOn}`;
  return r.reimbursement.statusUnavailable ? "Payment status unavailable" : "Not yet paid";
}

/** Reimbursements someone else uploaded for the caller: what finance and the approvers did with each. */
export default function ReimbursedList() {
  const rows = useLoad<ReimbursedRow[]>("/reimbursements");
  if (rows.error) return <Alert color="red">{rows.error}</Alert>;
  if (!rows.data) return null;
  if (rows.data.length === 0) return <Text c="dimmed">No one else has uploaded a receipt reimbursing you.</Text>;
  return (
    <Table.ScrollContainer minWidth={560}>
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Date</Table.Th>
            <Table.Th>Retailer</Table.Th>
            <Table.Th>Total</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Reimbursement</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.data.map((r) => {
            const s = status(r);
            return (
              <Table.Tr key={r.id}>
                <Table.Td>{r.receiptDate ?? "—"}</Table.Td>
                <Table.Td>{r.retailer ?? "—"}</Table.Td>
                <Table.Td>{dollars(r.receiptTotalCents)}</Table.Td>
                <Table.Td><Text size="sm" c={s.color}>{s.text}</Text></Table.Td>
                <Table.Td>{paid(r)}</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
