"use client";
import { useState } from "react";
import Link from "next/link";
import { Anchor, Badge, Button, Group, Paper, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { BASE, dollars, STATE_LABELS } from "./api";
import ReceiptFile from "./ReceiptFile";

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

const ROWS: Row[] = [
  { label: "Vendor", value: (r) => r.retailer },
  { label: "Date", value: (r) => r.receiptDate },
  { label: "Receipt #", value: (r) => r.receiptNumber },
  { label: "Order #", value: (r) => r.orderNumber },
  { label: "Shipping", value: (r) => dollars(r.shippingCents) },
  { label: "Tax", value: (r) => dollars(r.taxCents) },
  { label: "Discount", value: (r) => dollars(r.discountCents) },
  { label: "Total", value: (r) => `${dollars(r.receiptTotalCents)}${r.currency && r.currency !== "USD" ? ` ${r.currency}` : ""}` },
  { label: "File type", value: (r) => r.mimeType },
  { label: "Uploaded", value: (r) => new Date(r.uploadedAt).toLocaleString() },
];

const EMPTY = new Set(["", "—"]);

/** Rows where both receipts hold the same non-empty value are what made them look alike. */
const same = (a: string | null | undefined, b: string | null | undefined) => a != null && !EMPTY.has(a) && a === b;

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
                <Table.Td>{dollars(l.unitPriceCents)}</Table.Td>
                <Table.Td>{dollars(l.totalPriceCents)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

interface Props {
  receipt: CompareReceipt;
  /** Null while the original loads or when it could not be read. */
  original: CompareReceipt | null;
  originalHref: string;
  /** FINANCE acts; BOARD reads the same compare without actions. */
  isFinance: boolean;
  /** The caller uploaded this receipt, so someone else in finance decides it. */
  own: boolean;
  onClear: () => void;
  onRejectOriginal: (reason: string) => void;
}

/**
 * A suspected duplicate beside the receipt it was matched to, with finance's decisions on the
 * original. Rejecting this receipt, or its uploader discarding it, sits with its other actions.
 */
export default function DuplicateCompare({ receipt, original, originalHref, isFinance, own, onClear, onRejectOriginal }: Props) {
  const [reason, setReason] = useState("");
  const sameFile = original != null && same(receipt.fileHash, original.fileHash);
  return (
    <Paper withBorder p="sm">
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={5}>Possible duplicate</Title>
          <Anchor component={Link} href={originalHref} size="sm">Open the suspected original</Anchor>
        </Group>
        {original && (
          <Text size="sm">
            {sameFile ? "Both receipts are the same file." : "The files differ; the receipts match on their details."}
          </Text>
        )}
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th />
              <Table.Th>This receipt <Badge size="xs" variant="light">{STATE_LABELS[receipt.state] ?? receipt.state}</Badge></Table.Th>
              <Table.Th>
                Suspected original{original && <> <Badge size="xs" variant="light">{STATE_LABELS[original.state] ?? original.state}</Badge></>}
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {ROWS.map((row) => {
              const mine = row.value(receipt);
              const theirs = original ? row.value(original) : null;
              const matched = original != null && row.label !== "Uploaded" && same(mine, theirs);
              return (
                <Table.Tr key={row.label} bg={matched ? "var(--mantine-color-blue-light)" : undefined}>
                  <Table.Td>
                    {row.label}
                    {matched && <Badge ml="xs" size="xs" color="blue">Same</Badge>}
                  </Table.Td>
                  <Table.Td>{mine || "—"}</Table.Td>
                  <Table.Td>{original ? theirs || "—" : "—"}</Table.Td>
                </Table.Tr>
              );
            })}
            <Table.Tr bg={sameFile ? "var(--mantine-color-blue-light)" : undefined}>
              <Table.Td>
                File
                {sameFile && <Badge ml="xs" size="xs" color="blue">Same</Badge>}
              </Table.Td>
              <Table.Td>
                <Text size="xs" ff="monospace" title={receipt.fileHash}>{receipt.fileHash?.slice(0, 12) ?? "—"}</Text>
              </Table.Td>
              <Table.Td>
                {original && <Text size="xs" ff="monospace" title={original.fileHash}>{original.fileHash?.slice(0, 12) ?? "—"}</Text>}
              </Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>

        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <FileView title="This receipt's file" receipt={receipt} />
          {original ? <FileView title="The original's file" receipt={original} /> : <Text size="sm" c="dimmed">{"The original's file is not loaded."}</Text>}
        </SimpleGrid>

        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <Lines title="This receipt's lines" lines={receipt.lineItems} />
          {original ? <Lines title="The original's lines" lines={original.lineItems} /> : <Text size="sm" c="dimmed">The suspected original is not loaded.</Text>}
        </SimpleGrid>

        {isFinance ? (
          <Group gap="xs">
            {receipt.state === "duplicate_flagged" && !own && (
              <Button size="xs" onClick={onClear}>Not a duplicate</Button>
            )}
            {original && !own && !TERMINAL.has(original.state) && !original.pushedAt && (
              <Group align="end" gap="xs">
                <TextInput size="xs" label="Reason to reject the original" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
                <Button size="xs" variant="light" color="red" disabled={!reason.trim()} onClick={() => onRejectOriginal(reason.trim())}>Reject the original</Button>
              </Group>
            )}
            {own && <Text size="sm" c="dimmed">Someone else in finance decides whether your own receipt is a duplicate.</Text>}
          </Group>
        ) : (
          <Text size="sm" c="dimmed">Finance decides whether this is a duplicate.</Text>
        )}
      </Stack>
    </Paper>
  );
}
