"use client";
import { useState } from "react";
import { ActionIcon, Badge, Button, Group, Select, Table, Text, Title } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { send, useLoad, useRoles } from "../components/api";
import { LoadError } from "@checkin/component-ui";
import { LINE_ACCOUNT_TYPES } from "@checkin/quickbooks/accountTypes";

interface QbAccount {
  id: number;
  name: string;
  qbAccount: string;
}

/** One account from QuickBooks' live list, as the host's books-map route returns it. */
interface LiveAccount {
  id: string;
  name: string;
  accountType: string;
  active: boolean;
}

/** Every type a rule or held line may book to: the expense types, and Fixed Asset for capital. */
const LISTED_TYPES: readonly string[] = [...LINE_ACCOUNT_TYPES.donatedGoods, ...LINE_ACCOUNT_TYPES.donatedCapital];

/** /expense/qb-accounts — the QuickBooks accounts that account-mapping rules and holds may name. */
export default function QbAccountsPage() {
  const { isFinance } = useRoles();
  const accounts = useLoad<QbAccount[]>("/qb-accounts");
  const live = useLoad<LiveAccount[]>("/api/books-map/quickbooks-accounts");
  const [picked, setPicked] = useState<string | null>(null);

  const liveById = new Map((live.data ?? []).map((a) => [a.id, a]));
  const options = (live.data ?? []).filter((a) => a.active && LISTED_TYPES.includes(a.accountType)).map((a) => ({ value: a.id, label: a.name }));
  const pickedAccount = picked ? liveById.get(picked) : undefined;

  return (
    <>
      <Title order={3} mb="xs">QuickBooks accounts</Title>
      <Text c="dimmed" mb="md">
        An account says what the money was spent on, such as supplies or equipment. Account mapping picks one for
        each expense line. Whose budget pays is a separate choice: the line&apos;s bucket, whose QuickBooks Class
        finance sets on Budgets.
      </Text>
      {accounts.error && <LoadError what="QuickBooks accounts" message={accounts.error} onRetry={accounts.reload} />}
      {live.error && <LoadError what="QuickBooks' account list" message={live.error} onRetry={live.reload} />}
      <Table maw={640}>
        <Table.Tbody>
          {(accounts.data ?? []).map((a) => {
            const inQb = liveById.get(a.qbAccount);
            return (
              <Table.Tr key={a.id}>
                <Table.Td>{a.name}</Table.Td>
                <Table.Td>
                  {inQb && (inQb.active ? inQb.name : `${inQb.name} (inactive)`)}
                  {live.data && !inQb && <Badge color="red" variant="light">Not in QuickBooks</Badge>}
                </Table.Td>
                <Table.Td>
                  {isFinance && (
                    <ActionIcon variant="subtle" color="red" aria-label="Delete account" onClick={async () => { if (await send(`/qb-accounts/${a.id}`, "DELETE", {}, "Account deleted")) accounts.reload(); }}>
                      <IconTrash size={16} />
                    </ActionIcon>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      {accounts.data?.length === 0 && <Text c="dimmed" mt="sm">No accounts yet.</Text>}
      {isFinance && live.data && (
        <Group mt="md" align="end">
          <Select label="QuickBooks account" data={options} value={picked} onChange={setPicked} searchable w={320} />
          <Button
            disabled={!pickedAccount}
            onClick={async () => {
              if (pickedAccount && await send("/qb-accounts", "POST", { name: pickedAccount.name, qbAccount: pickedAccount.id }, "Account added")) {
                setPicked(null);
                accounts.reload();
              }
            }}
          >Add</Button>
        </Group>
      )}
    </>
  );
}
