"use client";
import { Text, Title } from "@mantine/core";
import ConfirmationList from "../components/ConfirmationList";
import ReimbursedList from "../components/ReimbursedList";

/**
 * /receipts/confirm — reimbursements waiting for the caller's confirmation of their lines and
 * amounts: as the person reimbursed, whatever their membership or role, or as a Board member on
 * behalf of someone with no account. Below them, what became of the reimbursements someone else
 * uploaded for the caller.
 */
export default function ConfirmReceiptsPage() {
  return (
    <>
      <Title order={3} mb="md">Receipts to confirm</Title>
      <ConfirmationList empty={<Text c="dimmed">Nothing waits for your confirmation.</Text>} />
      <Title order={4} mt="xl" mb="md">Reimbursements others uploaded for you</Title>
      <ReimbursedList />
    </>
  );
}
