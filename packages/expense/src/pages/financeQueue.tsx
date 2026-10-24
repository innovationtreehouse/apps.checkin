"use client";
import { useEffect } from "react";
import Link from "next/link";
import { Anchor, Badge, Chip, Group, Table, Text } from "@mantine/core";
import { useLoad } from "../components/api";
import LoadError from "../components/LoadError";
import SignAllButton from "../components/SignAllButton";
import {
  FINANCE_QUEUE_REASONS,
  FINANCE_QUEUE_TABS,
  type FinanceQueueCounts,
  type FinanceQueueReasonCode,
  type FinanceQueueRow,
  type FinanceQueueTabKey,
} from "../financeQueue";

export { FINANCE_QUEUE_TABS, financeQueueTab, type FinanceQueueCounts, type FinanceQueueTabKey } from "../financeQueue";

/** The expense tabs' counts, reloaded whenever a write tells the nav to refetch. */
export function useFinanceQueueCounts(): { counts: FinanceQueueCounts | null; error: string | null } {
  const { data, error, reload } = useLoad<FinanceQueueCounts>("/finance-queue/counts");
  useEffect(() => {
    window.addEventListener("nav-counts-mutated", reload);
    return () => window.removeEventListener("nav-counts-mutated", reload);
  }, [reload]);
  return { counts: data, error };
}

function waited(since: string): string {
  const days = Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000);
  return days < 1 ? "today" : days === 1 ? "1 day" : `${days} days`;
}

const money = (cents: number, currency: string) => (cents / 100).toLocaleString("en-US", { style: "currency", currency });

/** Where a row opens: the expense, carrying the tab and the page to return to, or the reason's own link. */
function rowHref(row: FinanceQueueRow, queue: string, returnHref: string): string {
  if (!row.expenseId) return row.reasons[0].href ?? "#";
  return `/expense/expenses/${encodeURIComponent(row.expenseId)}?${new URLSearchParams({ queue, from: returnHref })}`;
}

interface ListProps {
  tab: FinanceQueueTabKey;
  counts: FinanceQueueCounts | null;
  /** The selected reason chip, from `?reason=`. */
  reason: string | null;
  /** The host's URL for this tab and chip, which a decision on the expense returns to. */
  returnHref: string;
  onReason: (reason: string | null) => void;
}

/**
 * One expense tab's rows: date, vendor, amount, the reasons in plain words, and how long it has
 * waited. A tab whose rows carry more than one reason shows a chip per reason that filters it.
 */
export function FinanceQueueList({ tab, counts, reason, returnHref, onReason }: ListProps) {
  const queue = FINANCE_QUEUE_TABS.find((t) => t.key === tab)!.queue;
  const rows = useLoad<FinanceQueueRow[]>(`/finance-queue?tab=${queue}`);
  useEffect(() => {
    window.addEventListener("nav-counts-mutated", rows.reload);
    return () => window.removeEventListener("nav-counts-mutated", rows.reload);
  }, [rows.reload]);
  if (rows.error) return <LoadError what="this tab" message={rows.error} onRetry={rows.reload} />;
  if (!rows.data) return <Text c="dimmed">Loading…</Text>;

  const codes = [...new Set(rows.data.flatMap((r) => r.reasons.map((x) => x.code)))];
  const byReason = counts?.[tab].byReason ?? {};
  const shown = reason ? rows.data.filter((r) => r.reasons.some((x) => x.code === reason)) : rows.data;
  return (
    <>
      {codes.length > 1 && (
        <Group gap="xs" mb="md">
          {codes.map((code) => (
            <Chip key={code} size="sm" checked={code === reason} onChange={() => onReason(code === reason ? null : code)}>
              {FINANCE_QUEUE_REASONS[code]} {byReason[code] ?? 0}
            </Chip>
          ))}
        </Group>
      )}
      {shown.length > 0 && (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th>Vendor</Table.Th>
              <Table.Th>Amount</Table.Th>
              <Table.Th>Waiting on</Table.Th>
              <Table.Th>Waiting</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {shown.map((row) => (
              <Table.Tr key={row.expenseId ?? `${row.reasons[0].href}:${row.date}:${row.vendorName}:${row.waitingSince}`}>
                <Table.Td>
                  <Anchor component={Link} href={rowHref(row, queue, returnHref)}>{row.date ?? "No date"}</Anchor>
                </Table.Td>
                <Table.Td>{row.vendorName ?? "Unknown vendor"}</Table.Td>
                <Table.Td>{money(row.amountCents, row.currency)}</Table.Td>
                <Table.Td>
                  {row.reasons.map((x) => (
                    <Badge key={x.code} variant="light" color="gray" mr={4} style={{ textTransform: "none" }}>{x.text}</Badge>
                  ))}
                  {tab === "toSign" && row.expenseId && <SignAllButton expenseId={row.expenseId} onSigned={rows.reload} />}
                </Table.Td>
                <Table.Td>{waited(row.waitingSince)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </>
  );
}
