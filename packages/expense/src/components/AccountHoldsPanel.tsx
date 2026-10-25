"use client";
import { useState } from "react";
import { Badge, Button, Group, Paper, Select, Table, Text } from "@mantine/core";
import { formatCents } from "@checkin/money";
import { send, useLoad } from "./api";
import NonInventoryBadge from "./NonInventoryBadge";

export interface HeldLine {
  id: number;
  description: string;
  totalPriceCents: number;
  manualQbAccount?: string | null;
  nonInventory?: boolean;
}
export interface Hold {
  id: number;
  lineItemId: number;
  reason: string;
  matchedRows: string;
  status: string;
}
interface QbAccount {
  id: number;
  name: string;
  qbAccount: string;
}
interface LookupContext {
  category: string | null;
  subcategory: string | null;
  partNumber: string | null;
}
interface MatchedRule {
  id: number;
  category: string;
  subcategory: string;
  partNumber: string;
  qbAccount: string;
}

export const HOLD_REASON_WORDS: Record<string, string> = {
  NO_MATCH: "No account rule matches",
  MULTIPLE_MATCHES: "Several account rules match",
  NO_PART_NUMBER: "No part number; pick an account",
  NON_INVENTORY: "Not stock; pick an account",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

function parseRows(matchedRows: string): unknown[] {
  try {
    const rows: unknown = JSON.parse(matchedRows);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** The category, subcategory and part number a no-match line was looked up by. */
export function lookupContextOf(matchedRows: string): LookupContext | null {
  const ctx = parseRows(matchedRows).map((r) => (isRecord(r) ? r._lookupContext : undefined)).find(isRecord);
  if (!ctx) return null;
  return { category: textOrNull(ctx.category), subcategory: textOrNull(ctx.subcategory), partNumber: textOrNull(ctx.partNumber) };
}

/** The account rules a several-match line matched. */
export function matchedRulesOf(matchedRows: string): MatchedRule[] {
  return parseRows(matchedRows).flatMap((r) =>
    isRecord(r) && typeof r.id === "number" && typeof r.qbAccount === "string"
      ? [{ id: r.id, category: String(r.category), subcategory: String(r.subcategory), partNumber: String(r.partNumber), qbAccount: r.qbAccount }]
      : [],
  );
}

/**
 * Lines the QuickBooks processor could not give an account. FINANCE sets one per line and resubmits;
 * Resubmit stays disabled while a held line has no account, and the server refuses it as well.
 */
export default function AccountHoldsPanel({ expenseId, holds, lines, currency, isFinance, onChanged }: {
  expenseId: string;
  holds: Hold[];
  lines: HeldLine[];
  currency: string;
  isFinance: boolean;
  onChanged: () => void;
}) {
  const pending = holds.filter((h) => h.status === "PENDING");
  const accounts = useLoad<QbAccount[]>(pending.length > 0 ? "/qb-accounts" : null);
  const [picked, setPicked] = useState<Record<number, string | null>>({});
  if (pending.length === 0) return null;

  const base = `/expense-holds/${encodeURIComponent(expenseId)}`;
  const lineOf = new Map(lines.map((l) => [l.id, l]));
  const accountName = new Map((accounts.data ?? []).map((a) => [a.qbAccount, a.name]));
  const accountLabel = (code: string) => (accountName.has(code) ? `${accountName.get(code)} (${code})` : code);
  const options = (accounts.data ?? []).map((a) => ({ value: a.qbAccount, label: `${a.name} (${a.qbAccount})` }));
  const withoutAccount = pending.filter((h) => !lineOf.get(h.lineItemId)?.manualQbAccount).length;

  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" mb="xs">
        <Text fw={600}>Account holds</Text>
        {isFinance && (
          <Group gap="xs">
            {withoutAccount > 0 && (
              <Text size="xs" c="dimmed">
                {withoutAccount === 1 ? "1 held line has no account yet" : `${withoutAccount} held lines have no account yet`}
              </Text>
            )}
            <Button
              size="xs"
              disabled={withoutAccount > 0}
              onClick={async () => { if (await send(`${base}/resubmit`, "POST", {}, "Resubmitted")) onChanged(); }}
            >Resubmit</Button>
          </Group>
        )}
      </Group>
      <Table>
        <Table.Tbody>
          {pending.map((h) => {
            const line = lineOf.get(h.lineItemId);
            const ctx = h.reason === "NO_MATCH" ? lookupContextOf(h.matchedRows) : null;
            const rules = h.reason === "MULTIPLE_MATCHES" ? matchedRulesOf(h.matchedRows) : [];
            return (
              <Table.Tr key={h.id}>
                <Table.Td>
                  {line?.description ?? `Line #${h.lineItemId}`}{line?.nonInventory && <NonInventoryBadge />}
                </Table.Td>
                <Table.Td>{formatCents(line?.totalPriceCents ?? 0, currency)}</Table.Td>
                <Table.Td>
                  <Badge variant="light" color="orange">{HOLD_REASON_WORDS[h.reason] ?? h.reason}</Badge>
                  {ctx && (
                    <Text size="xs" c="dimmed" mt={4}>
                      Looked up by category {ctx.category ?? "—"}, subcategory {ctx.subcategory ?? "—"}, part number {ctx.partNumber ?? "—"}
                    </Text>
                  )}
                  {rules.map((r) => (
                    <Text key={r.id} size="xs" c="dimmed" mt={4}>
                      Rule {r.category} / {r.subcategory} / {r.partNumber} → {accountLabel(r.qbAccount)}
                    </Text>
                  ))}
                </Table.Td>
                <Table.Td>
                  {isFinance ? (
                    <Group gap="xs">
                      <Select
                        size="xs"
                        aria-label="QuickBooks account"
                        data={options}
                        value={picked[h.id] ?? line?.manualQbAccount ?? null}
                        onChange={(v) => setPicked({ ...picked, [h.id]: v })}
                        placeholder="QB account"
                      />
                      <Button
                        size="xs"
                        variant="light"
                        disabled={!picked[h.id]}
                        onClick={async () => {
                          if (await send(`${base}/line-items/${h.lineItemId}/account`, "PUT", { qbAccount: picked[h.id] }, "Account set")) onChanged();
                        }}
                      >Set account</Button>
                    </Group>
                  ) : (line?.manualQbAccount ? accountLabel(line.manualQbAccount) : "—")}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}
