"use client";
import { useState } from "react";
import { Alert, Button, Group, Modal, Paper, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { HttpError, showError, showSuccess } from "@checkin/component-ui";
import MailCatchUp from "../components/MailCatchUp";
import ReceiptFile from "../components/ReceiptFile";
import { api, BASE, errorMessage, send, useLoad } from "../components/api";
import { releaseAll, releaseOne } from "../components/releaseAll";

interface MailItem {
  id: number;
  receivedAt: string;
  senderAddress: string;
  status: string;
  holdReason: string | null;
  dmarcVerdict: string | null;
  mimeType: string | null;
  /** Set on a message's refusal note, which names what was not accepted and keeps no file. */
  refusal: { file: string; reason: string }[] | null;
}

const REFUSED_FILES: Record<string, string> = {
  wrong_type: "An attachment we can't read",
  forwarded: "An email attached as a file, which we don't open",
  too_large: "A file over the 10 MB limit",
  empty: "An empty file",
  no_amount: "Text that names no amount",
};

const HOLD_REASONS: Record<string, string> = {
  unverified_sender: "Sender could not be verified: the mail may not be from this address",
  not_a_submitter: "Verified sender, but no one who may submit receipts uses this address",
  side_copy: "A submitter's reply to one of our notices, or a copy with the receipt mailbox only in Cc: the sender was not replied to",
};

const DMARC_VERDICTS: Record<string, string> = {
  pass: "Sender check: passed",
  fail: "Sender check: failed",
  none: "Sender check: the sender's domain publishes no DMARC record",
};

interface IgnoredFile {
  id: number;
  fileHash: string;
  reason: string;
  createdAt: string;
}

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
    if (out.error) showError(`${summary}. Stopped: ${out.error}. ${out.notReached} not tried.`);
    else showSuccess(`${summary}.`);
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
  const act = async (verb: string, body: unknown, success: string, failed: string) => {
    if (await send(`${path}/${verb}`, "POST", body, success, failed)) onDone();
  };
  return (
    <Paper withBorder p="md">
      <Stack>
        <Group justify="space-between">
          <Text fw={500}>{item.senderAddress || "Unknown sender"}</Text>
          <Text c="dimmed">{new Date(item.receivedAt).toLocaleString()}</Text>
        </Group>
        {item.status === "held" && <Text size="sm">{HOLD_REASONS[item.holdReason ?? ""] ?? "Reason not recorded"}</Text>}
        <Text size="sm">{DMARC_VERDICTS[item.dmarcVerdict ?? ""] ?? "Sender check: not recorded"}</Text>
        {item.refusal ? (
          <Stack gap={4}>
            {item.refusal.map((r) => (
              <Text key={`${r.reason}:${r.file}`} size="sm">{REFUSED_FILES[r.reason] ?? "A file we did not accept"} ({r.file})</Text>
            ))}
            <Text size="sm" c="dimmed">Nothing was kept: find the email in the mailbox by its sender and date, or discard this.</Text>
          </Stack>
        ) : (
          item.mimeType && <ReceiptFile src={`${BASE}${path}/file`} mimeType={item.mimeType} />
        )}
        {item.status === "deferred" && (
          <Group>
            <Button onClick={() => act("assign", { release: true }, "Released", "Couldn't release this mail")}>Release now as the sender</Button>
          </Group>
        )}
        {!item.refusal && <Group align="end">
          <TextInput label="Assign to (sign-in email)" value={email} onChange={(e) => setEmail(e.currentTarget.value)} style={{ flex: 1 }} />
          <Button disabled={!email.trim()} onClick={() => act("assign", { email }, "Receipt created", "Couldn't assign this mail")}>Assign</Button>
          {item.status === "held" && item.dmarcVerdict === "pass" && (
            <Button
              variant="light"
              disabled={!email.trim()}
              onClick={() => act("assign", { email, remember: true }, "Receipt created; this address is now theirs", "Couldn't assign this mail and remember the address")}
            >
              Assign and remember this address as theirs
            </Button>
          )}
        </Group>}
        {!item.refusal && item.status === "held" && item.dmarcVerdict !== "pass" && (
          <Text size="sm" c="dimmed">This address can&apos;t be remembered as the assignee&apos;s: its sender check did not pass.</Text>
        )}
        <Group align="end">
          <TextInput label="Discard reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} style={{ flex: 1 }} />
          <Button color="red" variant="light" disabled={!reason.trim()} onClick={() => act("discard", { reason }, "Discarded", "Couldn't discard this mail")}>Discard</Button>
          {!item.refusal && (
            <Button
              color="red"
              variant="subtle"
              disabled={!reason.trim()}
              onClick={() => act("discard", { reason, ignoreFile: true }, "Discarded; this file is ignored from now on", "Couldn't discard and ignore this file")}
            >
              Discard and ignore this file from now on
            </Button>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}

/** The ignore list: files mail intake skips. Removing one lets intake read that file in mail it has not yet skipped. */
function IgnoredFiles({ entries, onDone }: { entries: IgnoredFile[]; onDone: () => void }) {
  if (entries.length === 0) return null;
  const remove = async (id: number) => {
    if (await send(`/ignored-files/${id}`, "DELETE", undefined, "Removed from the ignore list", "Couldn't remove the file from the ignore list")) onDone();
  };
  return (
    <Stack mt="xl">
      <Title order={4}>Ignored files</Title>
      <Text c="dimmed">Mail intake skips these exact files. Removing one applies to mail not yet skipped.</Text>
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

interface CapturedEmail {
  id: number;
  receivedAt: string;
  capturedAt: string;
  expired: boolean;
}

type ReplayOutcome = { status: "processed" | "waiting" } | { status: "expired"; message: string };

const REPLAY_FAILED = "Couldn't process this email again";
const REPLAY_WAITING = "Processed again, but a file in it waits for a later run: a sender's daily upload limit or the held-mail limit put it off";
const REPLAY_CRASHED = "Processing it again failed. The reason is recorded on the email, not shown here; try again later";

/** The words a refused replay shows: the server's own reason, or fixed text when a server failure brings none. */
function replayRefusal(err: unknown): string {
  return err instanceof HttpError && err.status >= 500 ? REPLAY_CRASHED : errorMessage(err);
}

/** Captured emails not yet processed; each one inside retention can be processed again from its stored copy. */
function CapturedEmails({ emails, onDone }: { emails: CapturedEmail[]; onDone: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  if (emails.length === 0) return null;
  const replay = async (id: number) => {
    setBusy(id);
    try {
      const out = await api<ReplayOutcome>(`/mail-messages/${id}/replay`, { method: "POST" });
      if (out.status === "processed") showSuccess("Processed");
      else showError(out.status === "expired" ? out.message : REPLAY_WAITING, { title: REPLAY_FAILED });
    } catch (err) {
      showError(replayRefusal(err), { title: REPLAY_FAILED });
    } finally {
      setBusy(null);
      onDone();
    }
  };
  return (
    <Stack mb="xl">
      <Title order={4}>Captured emails not yet processed</Title>
      <Text c="dimmed">These emails were saved from the mailbox but not yet turned into receipts or held mail.</Text>
      <Table>
        <Table.Thead>
          <Table.Tr><Table.Th>Received</Table.Th><Table.Th>Captured</Table.Th><Table.Th /></Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {emails.map((e) => (
            <Table.Tr key={e.id}>
              <Table.Td>{new Date(e.receivedAt).toLocaleString()}</Table.Td>
              <Table.Td>{new Date(e.capturedAt).toLocaleString()}</Table.Td>
              <Table.Td>
                {e.expired ? (
                  <Text size="sm" c="dimmed">Expired, can&apos;t be replayed</Text>
                ) : (
                  <Button size="compact-sm" variant="light" loading={busy === e.id} disabled={busy !== null} onClick={() => void replay(e.id)}>
                    Process again
                  </Button>
                )}
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
 * the file to the ignore list, listed below the queue. "Catch up now" reads the mailbox without
 * waiting for the daily run. Captured emails not yet processed are listed first, each with
 * "Process again" until its stored copy expires. FINANCE only.
 */
export default function ReceiptMailQueuePage() {
  const items = useLoad<MailItem[]>("/mail-items");
  const ignored = useLoad<IgnoredFile[]>("/ignored-files");
  const captured = useLoad<CapturedEmail[]>("/mail-messages");
  const reload = () => {
    items.reload();
    ignored.reload();
  };
  const replayed = () => {
    captured.reload();
    items.reload();
  };
  const deferred = items.data?.filter((i) => i.status === "deferred") ?? [];
  const held = items.data?.filter((i) => i.status !== "deferred") ?? [];
  const bySender = new Map<string, MailItem[]>();
  for (const i of deferred) bySender.set(i.senderAddress, [...(bySender.get(i.senderAddress) ?? []), i]);
  const card = (item: MailItem) => <MailItemCard key={item.id} item={item} onDone={reload} />;
  return (
    <>
      <Title order={3} mb="md">Incoming receipt queue</Title>
      <MailCatchUp onDone={items.reload} />
      {items.error && <Alert color="red" mb="md">{items.error}</Alert>}
      {ignored.error && <Alert color="red" mb="md">{ignored.error}</Alert>}
      {captured.error && <Alert color="red" mb="md">{captured.error}</Alert>}
      <CapturedEmails emails={captured.data ?? []} onDone={replayed} />
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
