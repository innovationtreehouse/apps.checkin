"use client";
import { useState } from "react";
import { Alert, Button, Group, Modal, Paper, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import ReceiptFile from "../components/ReceiptFile";
import { BASE, send, useLoad } from "../components/api";
import { releaseAll } from "../components/releaseAll";

interface MailItem {
  id: number;
  receivedAt: string;
  senderAddress: string;
  status: string;
  mimeType: string;
}

interface IgnoredFile {
  id: number;
  fileHash: string;
  reason: string;
  createdAt: string;
}

const releaseOne = (id: number) =>
  fetch(`${BASE}/mail-items/${id}/assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ release: true }),
  });

/** A button that releases every given deferred item, one at a time, after a confirm showing the count. */
function ReleaseAllButton({ ids, label, onDone }: { ids: number[]; label: string; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [tried, setTried] = useState<number | null>(null);
  const run = async () => {
    setTried(0);
    const out = await releaseAll(ids, releaseOne, setTried);
    setTried(null);
    setConfirming(false);
    const summary = `Released ${out.released}, skipped ${out.skipped}`;
    notifications.show(
      out.error
        ? { color: "red", message: `${summary}. Stopped: ${out.error}. ${out.notReached} not tried.` }
        : { color: "green", message: `${summary}.` },
    );
    onDone();
  };
  const running = tried !== null;
  return (
    <>
      <Button variant="light" onClick={() => setConfirming(true)}>{label} ({ids.length})</Button>
      <Modal opened={confirming} onClose={() => !running && setConfirming(false)} title={label}>
        <Stack>
          <Text>
            Release {ids.length} deferred file(s) now? Each becomes a receipt by its sender, outside their daily
            upload limit for that file.
          </Text>
          {running && <Text c="dimmed">Releasing {tried} of {ids.length}…</Text>}
          <Group justify="end">
            <Button variant="default" disabled={running} onClick={() => setConfirming(false)}>Cancel</Button>
            <Button loading={running} onClick={run}>Release {ids.length}</Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
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
        {item.status === "deferred" && (
          <Group>
            <Button onClick={() => act("assign", { release: true }, "Released")}>Release now as the sender</Button>
          </Group>
        )}
        <Group align="end">
          <TextInput label="Assign to (sign-in email)" value={email} onChange={(e) => setEmail(e.currentTarget.value)} style={{ flex: 1 }} />
          <Button disabled={!email.trim()} onClick={() => act("assign", { email }, "Receipt created")}>Assign</Button>
        </Group>
        <Group align="end">
          <TextInput label="Discard reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} style={{ flex: 1 }} />
          <Button color="red" variant="light" disabled={!reason.trim()} onClick={() => act("discard", { reason }, "Discarded")}>Discard</Button>
          <Button
            color="red"
            variant="subtle"
            disabled={!reason.trim()}
            onClick={() => act("discard", { reason, ignoreFile: true }, "Discarded; this file is ignored from now on")}
          >
            Discard and ignore this file from now on
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

/** The ignore list: files mail intake skips. Removing one lets intake read that file again from its next run. */
function IgnoredFiles({ entries, onDone }: { entries: IgnoredFile[]; onDone: () => void }) {
  if (entries.length === 0) return null;
  const remove = async (id: number) => {
    if (await send(`/ignored-files/${id}`, "DELETE", undefined, "Removed from the ignore list")) onDone();
  };
  return (
    <Stack mt="xl">
      <Title order={4}>Ignored files</Title>
      <Text c="dimmed">Mail intake skips these exact files. Removing one applies from the next run.</Text>
      <Table>
        <Table.Thead>
          <Table.Tr><Table.Th>Reason</Table.Th><Table.Th>File</Table.Th><Table.Th>Added</Table.Th><Table.Th /></Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {entries.map((e) => (
            <Table.Tr key={e.id}>
              <Table.Td>{e.reason}</Table.Td>
              <Table.Td><Text ff="monospace" size="sm" title={e.fileHash}>{e.fileHash.slice(0, 12)}</Text></Table.Td>
              <Table.Td>{new Date(e.createdAt).toLocaleDateString()}</Table.Td>
              <Table.Td>
                <Button size="compact-xs" variant="subtle" color="red" onClick={() => void remove(e.id)}>Remove</Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

/**
 * /receipts/mail — mailed receipts awaiting finance. Deferred items, from known senders over their
 * daily upload limit, can be released as their sender, one by one, by sender, or all at once.
 * Held items, from unknown senders, are assigned or discarded one by one. Discarding can also add
 * the file to the ignore list, listed below the queue. FINANCE only.
 */
export default function ReceiptMailQueuePage() {
  const items = useLoad<MailItem[]>("/mail-items");
  const ignored = useLoad<IgnoredFile[]>("/ignored-files");
  const reload = () => {
    items.reload();
    ignored.reload();
  };
  const deferred = items.data?.filter((i) => i.status === "deferred") ?? [];
  const held = items.data?.filter((i) => i.status !== "deferred") ?? [];
  const bySender = new Map<string, MailItem[]>();
  for (const i of deferred) bySender.set(i.senderAddress, [...(bySender.get(i.senderAddress) ?? []), i]);
  const card = (item: MailItem) => <MailItemCard key={item.id} item={item} onDone={reload} />;
  return (
    <>
      <Title order={3} mb="md">Mail queue</Title>
      {items.error && <Alert color="red" mb="md">{items.error}</Alert>}
      {ignored.error && <Alert color="red" mb="md">{ignored.error}</Alert>}
      {items.data?.length === 0 && <Text c="dimmed">No held mail.</Text>}
      {deferred.length > 0 && (
        <Stack mb="xl">
          <Group justify="space-between">
            <Title order={4}>Deferred: over the sender&apos;s daily upload limit</Title>
            <ReleaseAllButton ids={deferred.map((i) => i.id)} label="Release all deferred" onDone={items.reload} />
          </Group>
          <Text c="dimmed">These are read automatically once the sender has allowance again.</Text>
          {[...bySender].map(([sender, group]) => (
            <Stack key={sender}>
              <Group justify="space-between">
                <Text fw={500}>{sender}</Text>
                <ReleaseAllButton ids={group.map((i) => i.id)} label={`Release all from ${sender}`} onDone={items.reload} />
              </Group>
              {group.map(card)}
            </Stack>
          ))}
        </Stack>
      )}
      {held.length > 0 && (
        <Stack>
          <Title order={4}>Held: unknown or unverified sender</Title>
          {held.map(card)}
        </Stack>
      )}
      <IgnoredFiles entries={ignored.data ?? []} onDone={ignored.reload} />
    </>
  );
}
