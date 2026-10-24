"use client";
import { Text, Title } from "@mantine/core";
import ConfirmationList from "../components/ConfirmationList";

/**
 * /receipts/confirm — reimbursements waiting for the caller's confirmation of their lines and
 * amounts: as the person reimbursed, whatever their membership or role, or as a Board member on
 * behalf of someone with no account.
 */
export default function ConfirmReceiptsPage() {
  return (
    <>
      <Title order={3} mb="md">Receipts to confirm</Title>
      <ConfirmationList empty={<Text c="dimmed">Nothing waits for your confirmation.</Text>} />
    </>
  );
}
