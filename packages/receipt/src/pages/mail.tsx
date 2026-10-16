"use client";
import { useState } from "react";
import { Alert, Button, Group, Paper, Stack, Text, TextInput, Title } from "@mantine/core";
import ReceiptFile from "../components/ReceiptFile";
import { BASE, send, useLoad } from "../components/api";

interface MailItem {
  id: number;
  receivedAt: string;
  senderAddress: string;
  mimeType: string;
}

function MailItemCard({ item, onDone }: { item: MailItem; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const path = `/mail-items/${item.id}`;
  const act = async (verb: string, body: unknown, success: string) => {
    if (await send(`${path}/${verb}`, "POST", body, success)) onDone();
  };
  return (
    <Paper withBorder p="md">
      <Stack>
        <Group justify="space-between">
          <Text fw={500}>{item.senderAddress || "Unknown sender"}</Text>
          <Text c="dimmed">{new Date(item.receivedAt).toLocaleString()}</Text>
        </Group>
        <ReceiptFile src={`${BASE}${path}/file`} mimeType={item.mimeType} />
        <Group align="end">
          <TextInput label="Assign to (sign-in email)" value={email} onChange={(e) => setEmail(e.currentTarget.value)} style={{ flex: 1 }} />
          <Button disabled={!email.trim()} onClick={() => act("assign", { email }, "Receipt created")}>Assign</Button>
        </Group>
        <Group align="end">
          <TextInput label="Discard reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} style={{ flex: 1 }} />
          <Button color="red" variant="light" disabled={!reason.trim()} onClick={() => act("discard", { reason }, "Discarded")}>Discard</Button>
        </Group>
      </Stack>
    </Paper>
  );
}

/** /receipts/mail — mailed receipts held for finance: assign each to its submitter, or discard it. FINANCE only. */
export default function ReceiptMailQueuePage() {
  const items = useLoad<MailItem[]>("/mail-items");
  return (
    <>
      <Title order={3} mb="md">Mail queue</Title>
      {items.error && <Alert color="red" mb="md">{items.error}</Alert>}
      {items.data?.length === 0 && <Text c="dimmed">No held mail.</Text>}
      <Stack>
        {items.data?.map((item) => <MailItemCard key={item.id} item={item} onDone={items.reload} />)}
      </Stack>
    </>
  );
}
