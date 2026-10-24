"use client";
import { Alert, Badge, Button, Paper, Stack, Table, Text, Title } from "@mantine/core";
import { dollars, send, useLoad, type ReceiptConfirmation, type ReceiptListRow } from "./api";

/** A reimbursement's confirm is the submitter's signature on its lines and amounts. */
export const CONFIRM_AS_READ = "These lines and amounts are right";

const CHANGED_FIELD_LABELS: Record<string, string> = {
  lineItems: "line items",
  receiptDate: "receipt date",
  shippingCents: "shipping",
  taxCents: "tax",
  discountCents: "discount",
  receiptTotalCents: "total",
  reimbursee: "reimbursee",
};

/** A reimbursement for someone other than its uploader: the person reimbursed confirms it. */
export function confirmedByReimbursee(r: Pick<ReceiptListRow, "needsReimbursement" | "reimburseePersonId" | "uploadedByUserId">): boolean {
  return r.needsReimbursement && r.reimburseePersonId != null && r.reimburseePersonId !== r.uploadedByUserId;
}

/**
 * Reimbursements waiting for the caller to confirm them as read: as the person reimbursed, or as a
 * Board member on behalf of someone with no account. Renders nothing when none waits.
 */
export default function ConfirmationList() {
  const list = useLoad<ReceiptConfirmation[]>("/confirmations");
  if (list.error) return <Alert color="red" mb="md">{list.error}</Alert>;
  if (!list.data?.length) return null;
  const confirm = async (id: string) => {
    if (await send(`/${id}/confirmation`, "POST", {}, "Confirmed", "Couldn't confirm this receipt")) list.reload();
  };
  return (
    <Stack mb="lg">
      <Title order={4}>Receipts to confirm</Title>
      {list.data.map((c) => (
        <Paper key={c.id} withBorder p="sm">
          <Stack gap="xs">
            <Text fw={500}>
              {c.retailer ?? "—"}, {c.receiptDate ?? "—"}: {dollars(c.receiptTotalCents)} (tax {dollars(c.taxCents)}, shipping {dollars(c.shippingCents)}
              {c.discountCents ? `, discount ${dollars(c.discountCents)}` : ""})
              {c.onBehalf && <Badge ml="xs" size="sm">For a person with no account</Badge>}
            </Text>
            {c.changedFields.length > 0 && (
              <Alert color="orange">
                Finance changed this receipt; confirm it again. Changed: {c.changedFields.map((f) => CHANGED_FIELD_LABELS[f] ?? f).join(", ")}.
              </Alert>
            )}
            <Table>
              <Table.Thead>
                <Table.Tr><Table.Th>Item</Table.Th><Table.Th>Qty</Table.Th><Table.Th>Total</Table.Th></Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {c.lineItems.map((l) => (
                  <Table.Tr key={l.id}>
                    <Table.Td>{l.description}</Table.Td>
                    <Table.Td>{l.quantity}</Table.Td>
                    <Table.Td>{dollars(l.totalPriceCents)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Button size="xs" w="fit-content" onClick={() => void confirm(c.id)}>{CONFIRM_AS_READ}</Button>
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
}
