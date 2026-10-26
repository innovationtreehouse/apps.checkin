"use client";
import Link from "next/link";
import { Anchor, Badge, Table, Text } from "@mantine/core";
import { dollars, isDiscardedDuplicate, receiptStateLabel, type ReceiptListRow } from "./api";
import { SUBMITTER_ACTION_STATES } from "../nav";
import { confirmedByReimbursee } from "./ConfirmationList";

/**
 * One row per receipt, linking to `detailHref` (its detail page). `paid` adds the reimbursement
 * column; `flagMine` marks the rows that wait on their uploader; `delivery` adds each
 * undelivered receipt's latest push failure and whether catch-up has given up on it. A receipt
 * discarded as a duplicate says so, linking the receipt it duplicates when the view carries it.
 */
export default function ReceiptTable({
  rows,
  paid = false,
  flagMine = false,
  delivery = false,
  detailHref = (id) => `/receipts/${id}`,
}: {
  rows: ReceiptListRow[];
  paid?: boolean;
  flagMine?: boolean;
  delivery?: boolean;
  detailHref?: (id: string) => string;
}) {
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
            {delivery && <Table.Th>Delivery to part mapping</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => (
            <Table.Tr key={r.id}>
              <Table.Td>
                <Anchor component={Link} href={detailHref(r.id)}>{new Date(r.uploadedAt).toLocaleDateString()}</Anchor>
              </Table.Td>
              <Table.Td>{r.retailer ?? "—"}{r.isInKind && <Badge ml="xs" size="xs">Donation</Badge>}</Table.Td>
              <Table.Td>{dollars(r.receiptTotalCents)}</Table.Td>
              <Table.Td>
                {receiptStateLabel(r)}
                {isDiscardedDuplicate(r) && r.duplicateSuspectReceiptId && (
                  <> of <Anchor component={Link} href={detailHref(r.duplicateSuspectReceiptId)}>another receipt</Anchor></>
                )}
                {flagMine && SUBMITTER_ACTION_STATES.includes(r.state) && !(r.state === "submitter_review" && confirmedByReimbursee(r)) && (
                  <Badge ml="xs" size="sm" color="treehouseGreen" c="black">Needs you</Badge>
                )}
              </Table.Td>
              {paid && (
                <Table.Td>
                  {r.reimbursement ? (r.reimbursement.paidOn ? `Paid on ${r.reimbursement.paidOn}` : r.reimbursement.statusUnavailable ? "Payment status unavailable" : "Not yet paid") : "—"}
                </Table.Td>
              )}
              {delivery && (
                <Table.Td>
                  {r.pushGivenUp && <Badge size="sm" color="red" mr="xs">Catch-up stopped: re-send by hand</Badge>}
                  {r.lastPushFailure ? (
                    <Text size="sm" span>
                      Failed{r.lastPushFailedAt ? ` ${new Date(r.lastPushFailedAt).toLocaleString()}` : ""}: {r.lastPushFailure}
                    </Text>
                  ) : (
                    <Text size="sm" c="dimmed" span>No failed attempt recorded</Text>
                  )}
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
