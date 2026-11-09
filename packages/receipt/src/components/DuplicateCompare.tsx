"use client";
import { useState } from "react";
import Link from "next/link";
import { Alert, Anchor, Badge, Button, Group, Paper, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { BASE, STATE_LABELS } from "./api";
import { formatCents } from "@checkin/money";
import ReceiptFile from "./ReceiptFile";
import { describeKept, describeShort, EXPENSE_REJECTED, REJECTED_AS_COPY } from "../lib/describeReceipt";
import type { DuplicateGroup, DuplicateMember } from "../lib/duplicateGroup";
import { retailerKey } from "../lib/retailer";

export interface CompareLine {
  id: number;
  lineNumber: number;
  description: string;
  partNumber?: string | null;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
}

/** The fields a duplicate decision rests on, as the finance and board views return them. */
export interface CompareReceipt {
  id: string;
  state: string;
  uploadedAt: string;
  fileHash?: string;
  mimeType: string;
  retailer: string | null;
  receiptDate: string | null;
  receiptNumber?: string | null;
  orderNumber?: string | null;
  currency?: string;
  shippingCents: number | null;
  taxCents: number | null;
  discountCents: number | null;
  receiptTotalCents: number | null;
  pushedAt?: string | null;
  isInKind: boolean;
  needsReimbursement: boolean;
  lineItems: CompareLine[];
}

const fileHref = (r: CompareReceipt) => `${BASE}/${encodeURIComponent(r.id)}/file`;

function FileView({ title, receipt }: { title: string; receipt: CompareReceipt }) {
  return (
    <Stack gap={4}>
      <Group justify="space-between">
        <Text fw={500} size="sm">{title}</Text>
        <Anchor href={fileHref(receipt)} download size="xs">Download</Anchor>
      </Group>
      <ReceiptFile src={fileHref(receipt)} mimeType={receipt.mimeType} title={title} />
    </Stack>
  );
}

const TERMINAL = new Set(["receipt_finalized", "discarded", "rejected"]);

type Row = { label: string; value: (r: CompareReceipt) => string | null | undefined };

const recordedAs = (r: CompareReceipt) => (r.isInKind ? "Gift of goods" : r.needsReimbursement ? "For reimbursement" : "Purchase");

const ROWS: Row[] = [
  { label: "Recorded as", value: recordedAs },
  { label: "Vendor", value: (r) => r.retailer },
  { label: "Date", value: (r) => r.receiptDate },
  { label: "Receipt #", value: (r) => r.receiptNumber },
  { label: "Order #", value: (r) => r.orderNumber },
  { label: "Shipping", value: (r) => formatCents(r.shippingCents) },
  { label: "Tax", value: (r) => formatCents(r.taxCents) },
  { label: "Discount", value: (r) => formatCents(r.discountCents) },
  { label: "Total", value: (r) => `${formatCents(r.receiptTotalCents)}${r.currency && r.currency !== "USD" ? ` ${r.currency}` : ""}` },
  { label: "File type", value: (r) => r.mimeType },
  { label: "Uploaded", value: (r) => new Date(r.uploadedAt).toLocaleString() },
];

/** Rows that describe a receipt without being a reason it matched. */
const NEVER_MATCHED = new Set(["Recorded as", "Uploaded"]);

const EMPTY = new Set(["", "—"]);

/** Rows where both receipts hold the same non-empty value are what made them look alike. */
const same = (a: string | null | undefined, b: string | null | undefined) => a != null && !EMPTY.has(a) && a === b;

/** An order or receipt number as the duplicate check compares it. */
const numberKey = (n: string | null | undefined) => (n ?? "").replace(/\s+/g, "").toLowerCase().replace(/^#/, "");

/** Why `other` is tied to the viewed receipt, in the check's own tiers (design §3.1). */
function matchedOn(viewed: CompareReceipt, other: CompareReceipt): string[] {
  const tiers: string[] = [];
  if (same(viewed.fileHash, other.fileHash)) tiers.push("Same file");
  const key = retailerKey(viewed.retailer);
  if (!key || key !== retailerKey(other.retailer)) return tiers;
  if (numberKey(viewed.orderNumber) && numberKey(viewed.orderNumber) === numberKey(other.orderNumber)) tiers.push("Same order number");
  if (numberKey(viewed.receiptNumber) && numberKey(viewed.receiptNumber) === numberKey(other.receiptNumber)) tiers.push("Same receipt number");
  if (viewed.receiptDate && viewed.receiptDate === other.receiptDate && viewed.receiptTotalCents === other.receiptTotalCents) tiers.push("Same vendor, date and total");
  return tiers;
}

function Lines({ title, lines }: { title: string; lines: CompareLine[] }) {
  return (
    <Stack gap={4}>
      <Text fw={500} size="sm">{title}</Text>
      {lines.length === 0 ? (
        <Text size="sm" c="dimmed">No lines</Text>
      ) : (
        <Table fz="xs" withTableBorder>
          <Table.Thead>
            <Table.Tr><Table.Th>#</Table.Th><Table.Th>Item</Table.Th><Table.Th>Part #</Table.Th><Table.Th>Qty</Table.Th><Table.Th>Unit</Table.Th><Table.Th>Total</Table.Th></Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {lines.map((l) => (
              <Table.Tr key={l.id}>
                <Table.Td>{l.lineNumber}</Table.Td>
                <Table.Td>{l.description}</Table.Td>
                <Table.Td>{l.partNumber ?? "—"}</Table.Td>
                <Table.Td>{l.quantity}</Table.Td>
                <Table.Td>{formatCents(l.unitPriceCents)}</Table.Td>
                <Table.Td>{formatCents(l.totalPriceCents)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

/** A member's state in words: red when it was refused, grey when withdrawn, the kept receipt linked. */
function MemberLabel({ member, hrefOf }: { member: DuplicateMember; hrefOf: (id: string) => string }) {
  const refused = member.state === "rejected" || member.label.startsWith(EXPENSE_REJECTED);
  const color = refused ? "red" : member.state === "discarded" ? "dimmed" : undefined;
  if (member.copyOfId && member.label.startsWith(REJECTED_AS_COPY)) {
    return (
      <Text size="xs" c={color}>
        {REJECTED_AS_COPY}
        <Anchor component={Link} href={hrefOf(member.copyOfId)} size="xs">{member.label.slice(REJECTED_AS_COPY.length)}</Anchor>
      </Text>
    );
  }
  return <Text size="xs" c={color}>{member.label}</Text>;
}

/** Finance's reject of one match, with the reason it requires. */
function RejectMatch({ title, onReject }: { title: string; onReject: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Group align="end" gap={4}>
      <TextInput size="xs" label={`Reason to reject ${title}`} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
      <Button size="xs" variant="light" color="red" disabled={!reason.trim()} onClick={() => onReject(reason.trim())}>Reject {title}</Button>
    </Group>
  );
}

interface Props {
  receipt: CompareReceipt;
  group: DuplicateGroup;
  /** Every other member's and dismissed match's receipt loaded so far, by id. */
  loaded: Map<string, CompareReceipt>;
  loadErrors: Map<string, string>;
  onRetry: () => void;
  /** The ids that joined the group after the panel was first drawn. */
  fresh: ReadonlySet<string>;
  hrefOf: (id: string) => string;
  /** FINANCE acts; BOARD reads the same compare without actions. */
  isFinance: boolean;
  /** The caller uploaded this receipt, so someone else in finance decides it. */
  own: boolean;
  onNotThisOne: (otherId: string) => void;
  onUndo: (otherId: string) => void;
  onDifferentPurchases: () => void;
  onKeepThisOne: () => void;
  onRejectMatch: (otherId: string, reason: string) => void;
  onRejectAsCopy: (reason: string) => void;
}

/**
 * The viewed receipt beside every other member of its group, in upload order, with finance's
 * decisions on each match and on the group. Rejecting this receipt, or its uploader discarding
 * it, sits with its other actions.
 */
export default function DuplicateCompare({ receipt, group, loaded, loadErrors, onRetry, fresh, hrefOf, isFinance, own, onNotThisOne, onUndo, onDifferentPurchases, onKeepThisOne, onRejectMatch, onRejectAsCopy }: Props) {
  const others = group.members.filter((m) => m.id !== receipt.id);
  const viewed = group.members.find((m) => m.id === receipt.id);
  const titleOf = (m: DuplicateMember) => `match ${others.indexOf(m) + 1}`;
  const live = others.filter((m) => m.state !== "discarded");
  const allLoaded = live.every((m) => loaded.has(m.id));
  const decides = isFinance && !own;
  const held = receipt.state === "duplicate_flagged";
  const giftAndReimbursement = live.some((m) => {
    const o = loaded.get(m.id);
    return o != null && ((receipt.isInKind && o.needsReimbursement) || (receipt.needsReimbursement && o.isInKind));
  });
  const finalized = live.find((m) => m.state === "receipt_finalized");
  const finalizedReceipt = finalized && loaded.get(finalized.id);
  const uploads = [receipt, ...others.flatMap((m) => loaded.get(m.id) ?? [])].map((r) => new Date(r.uploadedAt));
  const columns = Math.min(others.length + 1, 3);

  return (
    <Paper withBorder p="sm">
      <Stack gap="sm">
        <Title order={5}>Possible duplicate</Title>
        {group.dismissed.length > 0 && (
          <Group gap="xs" aria-label="Dismissed matches">
            <Text size="sm">Dismissed:</Text>
            {group.dismissed.map((id) => {
              const r = loaded.get(id);
              return (
                <Group key={id} gap={4}>
                  <Anchor component={Link} href={hrefOf(id)} size="sm">{r ? describeShort(r) : "another receipt"}</Anchor>
                  {decides && held && <Button size="compact-xs" variant="subtle" onClick={() => onUndo(id)}>Undo</Button>}
                </Group>
              );
            })}
          </Group>
        )}
        {giftAndReimbursement && (
          <Alert color="yellow">One is recorded as a gift of goods and another is for reimbursement. If they are the same purchase, reimbursing it would pay for goods recorded as given.</Alert>
        )}
        {decides && finalizedReceipt && (
          <Alert color="yellow">
            <Group justify="space-between">
              <Text size="sm">A finalized copy exists: keep it and reject this one as a copy?</Text>
              <Button
                size="xs"
                color="red"
                variant="light"
                onClick={() => onRejectAsCopy(`Copy of ${describeKept({ retailer: finalizedReceipt.retailer, uploadedAt: new Date(finalizedReceipt.uploadedAt) }, uploads)}`)}
              >
                Reject as a copy
              </Button>
            </Group>
          </Alert>
        )}
        <Table.ScrollContainer minWidth={220 * (others.length + 2)}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th />
                <Table.Th>
                  This receipt <Badge size="xs" variant="light">{STATE_LABELS[receipt.state] ?? receipt.state}</Badge>
                </Table.Th>
                {others.map((m) => (
                  <Table.Th key={m.id} style={m.state === "discarded" ? { opacity: 0.6 } : undefined}>
                    <Anchor component={Link} href={hrefOf(m.id)} size="sm">Open {titleOf(m)}</Anchor>
                    {fresh.has(m.id) && <Badge ml="xs" size="xs" color="blue">New</Badge>}
                    <MemberLabel member={m} hrefOf={hrefOf} />
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td>Uploaded by</Table.Td>
                <Table.Td>{viewed?.uploaderName ?? "—"}</Table.Td>
                {others.map((m) => <Table.Td key={m.id}>{m.uploaderName ?? "—"}</Table.Td>)}
              </Table.Tr>
              <Table.Tr>
                <Table.Td>Matched on</Table.Td>
                <Table.Td>—</Table.Td>
                {others.map((m) => {
                  const o = loaded.get(m.id);
                  const tiers = o ? matchedOn(receipt, o) : [];
                  return <Table.Td key={m.id}>{o ? (tiers.join(", ") || "Linked through another receipt") : "—"}</Table.Td>;
                })}
              </Table.Tr>
              {ROWS.map((row) => {
                const mine = row.value(receipt);
                return (
                  <Table.Tr key={row.label}>
                    <Table.Td>{row.label}</Table.Td>
                    <Table.Td>{mine || "—"}</Table.Td>
                    {others.map((m) => {
                      const o = loaded.get(m.id);
                      const theirs = o ? row.value(o) : null;
                      const matched = !NEVER_MATCHED.has(row.label) && same(mine, theirs);
                      return (
                        <Table.Td key={m.id} bg={matched ? "var(--mantine-color-blue-light)" : undefined}>
                          {theirs || "—"}
                          {matched && <Badge ml="xs" size="xs" color="blue">Same</Badge>}
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                );
              })}
              <Table.Tr>
                <Table.Td>File</Table.Td>
                <Table.Td><Text size="xs" ff="monospace" title={receipt.fileHash}>{receipt.fileHash?.slice(0, 12) ?? "—"}</Text></Table.Td>
                {others.map((m) => {
                  const o = loaded.get(m.id);
                  const matched = o != null && same(receipt.fileHash, o.fileHash);
                  return (
                    <Table.Td key={m.id} bg={matched ? "var(--mantine-color-blue-light)" : undefined}>
                      <Text size="xs" ff="monospace" span title={o?.fileHash}>{o?.fileHash?.slice(0, 12) ?? "—"}</Text>
                      {matched && <Badge ml="xs" size="xs" color="blue">Same</Badge>}
                    </Table.Td>
                  );
                })}
              </Table.Tr>
              {decides && (
                <Table.Tr>
                  <Table.Td>Decide</Table.Td>
                  <Table.Td />
                  {others.map((m) => {
                    const o = loaded.get(m.id);
                    const error = loadErrors.get(m.id);
                    if (m.state === "discarded") return <Table.Td key={m.id} />;
                    return (
                      <Table.Td key={m.id}>
                        {o ? (
                          <Stack gap={4}>
                            <Button size="xs" variant="light" w="fit-content" aria-label={`Not this one: ${titleOf(m)}`} onClick={() => onNotThisOne(m.id)}>Not this one</Button>
                            {!TERMINAL.has(o.state) && !o.pushedAt && <RejectMatch title={titleOf(m)} onReject={(reason) => onRejectMatch(m.id, reason)} />}
                          </Stack>
                        ) : error ? (
                          <Stack gap={4}>
                            <Text size="sm" c="red">{"Couldn't load this receipt: "}{error}</Text>
                            <Button size="xs" variant="light" w="fit-content" onClick={onRetry}>Retry</Button>
                          </Stack>
                        ) : (
                          <Text size="sm" c="dimmed">Loading…</Text>
                        )}
                      </Table.Td>
                    );
                  })}
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>

        <SimpleGrid cols={{ base: 1, md: columns }}>
          <FileView title="This receipt's file" receipt={receipt} />
          {others.map((m) => {
            const o = loaded.get(m.id);
            return o ? <FileView key={m.id} title={`File of ${titleOf(m)}`} receipt={o} /> : <Text key={m.id} size="sm" c="dimmed">The file of {titleOf(m)} is not loaded.</Text>;
          })}
        </SimpleGrid>

        <SimpleGrid cols={{ base: 1, md: columns }}>
          <Lines title="This receipt's lines" lines={receipt.lineItems} />
          {others.map((m) => {
            const o = loaded.get(m.id);
            return o ? <Lines key={m.id} title={`Lines of ${titleOf(m)}`} lines={o.lineItems} /> : <Text key={m.id} size="sm" c="dimmed">The lines of {titleOf(m)} are not loaded.</Text>;
          })}
        </SimpleGrid>

        {!isFinance ? (
          <Text size="sm" c="dimmed">Finance decides whether this is a duplicate.</Text>
        ) : own ? (
          <Text size="sm" c="dimmed">Someone else in finance decides whether your own receipt is a duplicate.</Text>
        ) : (
          allLoaded && (
            <Group gap="xs">
              <Button size="xs" onClick={onDifferentPurchases}>Different purchases</Button>
              {!finalized && <Button size="xs" variant="light" onClick={onKeepThisOne}>Keep this one</Button>}
            </Group>
          )
        )}
      </Stack>
    </Paper>
  );
}
