"use client";

import { useCallback, useEffect, useState } from "react";
import { Select, Stack, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { errorMessage } from "@checkin/component-ui";
import type { BooksMapRole } from "@checkin/quickbooks";
import { PageLoader } from "@/components/ui/PageLoader";
import { useRequireRole } from "@/hooks/useRequireRole";
import { api } from "@/lib/api";
import { FINANCE_ROLES } from "@/lib/nav/sections/finance";
import { BOOKS_MAP_ROLE_LABELS } from "@/lib/finance/booksMapLabels";

interface ClassRow {
  budgetOwnerId: number;
  budgetOwnerName: string;
  quickBooksClassId: string | null;
}

interface AccountRow {
  role: BooksMapRole;
  quickBooksAccountId: string | null;
}

interface Option {
  id: string;
  name: string;
  active: boolean;
}

function showError(title: string, message: string) {
  notifications.hide(title);
  notifications.show({ id: title, color: "red", title, message, autoClose: false });
}

/** Options for a picker: active entries, plus the saved one even when inactive or missing. */
function choices(options: Option[] | null, saved: string | null) {
  const list = (options ?? []).filter((o) => o.active || o.id === saved).map((o) => ({ value: o.id, label: o.active ? o.name : `${o.name} (inactive)` }));
  if (saved && !list.some((o) => o.value === saved)) list.push({ value: saved, label: `QuickBooks id ${saved}` });
  return list;
}

export default function BooksMapPage() {
  const { user, loading: authLoading, ready } = useRequireRole(FINANCE_ROLES);
  const isFinance = !!user?.isFinance;

  const [classRows, setClassRows] = useState<ClassRow[]>([]);
  const [accountRows, setAccountRows] = useState<AccountRow[]>([]);
  const [classes, setClasses] = useState<Option[] | null>(null);
  const [accounts, setAccounts] = useState<Option[] | null>(null);

  const load = useCallback(() => Promise.allSettled([
    api<{ BooksMapClass: ClassRow[]; BooksMapAccount: AccountRow[] }>("/api/books-map"),
    api<Option[]>("/api/budget-owners/quickbooks-classes"),
    api<Option[]>("/api/books-map/quickbooks-accounts"),
  ]).then(([map, c, a]) => {
    if (map.status === "fulfilled") { setClassRows(map.value.BooksMapClass); setAccountRows(map.value.BooksMapAccount); } else showError("Books map not loaded", errorMessage(map.reason));
    if (c.status === "fulfilled") setClasses(c.value); else showError("QuickBooks Classes unavailable", errorMessage(c.reason));
    if (a.status === "fulfilled") setAccounts(a.value); else showError("QuickBooks accounts unavailable", errorMessage(a.reason));
  }), []);

  useEffect(() => { if (ready) void load(); }, [ready, load]);

  const save = async (url: string, body: unknown, failed: string) => {
    notifications.hide(failed);
    try {
      await api(url, { method: "PUT", body: JSON.stringify(body) });
    } catch (e) {
      showError(failed, errorMessage(e));
      return;
    }
    notifications.show({ message: "Saved." });
    await load();
  };

  if (authLoading) return <PageLoader />;
  if (!ready) return null;

  return (
    <Stack>
      <Title order={2}>Books map</Title>
      <Text c="dimmed">
        Which QuickBooks account each kind of incoming money books to, and which QuickBooks Class each budget bucket
        books to. Income reads the Shopify and Benevity accounts and the Classes from here, gifts of goods read their four
        accounts and the Classes, and expenses read the Organisation card. Income books donation deposits from bulk uploads
        to the Benevity disbursements bank account below. {isFinance ? "Changes are recorded in the audit log." : "Finance edits them."}
      </Text>

      <Title order={4}>Accounts</Title>
      <Table>
        <Table.Thead><Table.Tr><Table.Th>Role</Table.Th><Table.Th>QuickBooks account</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>
          {accountRows.map((r) => (
            <Table.Tr key={r.role}>
              <Table.Td>{BOOKS_MAP_ROLE_LABELS[r.role] ?? r.role}</Table.Td>
              <Table.Td>
                <Select
                  aria-label={BOOKS_MAP_ROLE_LABELS[r.role] ?? r.role}
                  data={choices(accounts, r.quickBooksAccountId)}
                  value={r.quickBooksAccountId}
                  placeholder="Not set"
                  searchable
                  clearable
                  disabled={!isFinance}
                  onChange={(v) => void save(`/api/books-map/accounts/${r.role}`, { quickBooksAccountId: v }, "Account not saved")}
                />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Title order={4}>Classes</Title>
      <Table>
        <Table.Thead><Table.Tr><Table.Th>Bucket</Table.Th><Table.Th>QuickBooks Class</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>
          {classRows.map((r) => (
            <Table.Tr key={r.budgetOwnerId}>
              <Table.Td>{r.budgetOwnerName}</Table.Td>
              <Table.Td>
                <Select
                  aria-label={`Class for ${r.budgetOwnerName}`}
                  data={choices(classes, r.quickBooksClassId)}
                  value={r.quickBooksClassId}
                  placeholder="Not set"
                  searchable
                  clearable
                  disabled={!isFinance}
                  onChange={(v) => void save(`/api/books-map/classes/${r.budgetOwnerId}`, { quickBooksClassId: v }, "Class not saved")}
                />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
