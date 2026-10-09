"use client";
import { useState } from "react";
import { Anchor, Badge, Button, Group, Paper, Select, Stack, Table, Text, Title } from "@mantine/core";
import { formatCents } from "@inventory/money";
import { send, useLoad, useRoles } from "../components/api";
import LoadError from "../components/LoadError";
import ExpenseSubNav from "../components/ExpenseSubNav";

interface Hold {
  id: number;
  expenseId: string;
  lineItemId: number;
  reason: string;
  lineItem: { description: string; partNumber: string | null; totalPriceCents: number; manualQbAccount: string | null } | null;
  expense: { vendorName: string | null; receiptDate: string | null; currency: string } | null;
}
interface QbAccount {
  id: number;
  name: string;
  qbAccount: string;
}

/** /expense/holds — lines no account rule resolved; FINANCE sets an account and resubmits. */
export default function HoldsPage() {
  const { isFinance } = useRoles();
  const holds = useLoad<Hold[]>("/expense-holds");
  const accounts = useLoad<QbAccount[]>("/qb-accounts");
  const [picked, setPicked] = useState<Record<number, string | null>>({});

  const byExpense = new Map<string, Hold[]>();
  for (const h of holds.data ?? []) byExpense.set(h.expenseId, [...(byExpense.get(h.expenseId) ?? []), h]);
  const options = (accounts.data ?? []).map((a) => ({ value: a.qbAccount, label: `${a.name} (${a.qbAccount})` }));

  return (
    <>
      <ExpenseSubNav current="/expense/holds" />
      <Title order={3} mb="md">Account holds</Title>
      {holds.error && <LoadError what="holds" message={holds.error} onRetry={holds.reload} />}
      {holds.data?.length === 0 && <Text c="dimmed">No pending holds.</Text>}
      <Stack>
        {[...byExpense].map(([expenseId, rows]) => (
          <Paper key={expenseId} withBorder p="sm">
            <Group justify="space-between" mb="xs">
              <Anchor href={`/expense/expenses/${encodeURIComponent(expenseId)}`}>
                {rows[0].expense?.vendorName ?? expenseId} · {rows[0].expense?.receiptDate ?? ""}
              </Anchor>
              {isFinance && (
                <Button size="xs" onClick={async () => { if (await send(`/expense-holds/${encodeURIComponent(expenseId)}/resubmit`, "POST", {}, "Resubmitted")) holds.reload(); }}>
                  Resubmit
                </Button>
              )}
            </Group>
            <Table>
              <Table.Tbody>
                {rows.map((h) => (
                  <Table.Tr key={h.id}>
                    <Table.Td>{h.lineItem?.description}{h.lineItem?.partNumber && <Text size="xs" c="dimmed">{h.lineItem.partNumber}</Text>}</Table.Td>
                    <Table.Td>{formatCents(h.lineItem?.totalPriceCents ?? 0, h.expense?.currency)}</Table.Td>
                    <Table.Td><Badge variant="light" color="orange">{h.reason}</Badge></Table.Td>
                    <Table.Td>
                      {isFinance ? (
                        <Group gap="xs">
                          <Select
                            size="xs"
                            data={options}
                            value={picked[h.id] ?? h.lineItem?.manualQbAccount ?? null}
                            onChange={(v) => setPicked({ ...picked, [h.id]: v })}
                            placeholder="QB account"
                          />
                          <Button
                            size="xs"
                            variant="light"
                            disabled={!picked[h.id]}
                            onClick={async () => {
                              const path = `/expense-holds/${encodeURIComponent(expenseId)}/line-items/${h.lineItemId}/account`;
                              if (await send(path, "PUT", { qbAccount: picked[h.id] }, "Account set")) holds.reload();
                            }}
                          >Set</Button>
                        </Group>
                      ) : (h.lineItem?.manualQbAccount ?? "—")}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
        ))}
      </Stack>
    </>
  );
}
