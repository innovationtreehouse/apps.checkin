"use client";

import { useCallback, useEffect, useState } from "react";
import { Select, Stack, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { BooksMapRole } from "@checkin/quickbooks";
import { PageLoader } from "@/components/ui/PageLoader";
import { useRequireRole } from "@/hooks/useRequireRole";
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

/** Reads JSON, or says why it could not; never throws. */
async function request<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
  }
  const data: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, data: data as T };
  const error = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "The server returned an unexpected error.";
  return { ok: false, error: `${error} (${res.status})` };
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
  const { user, loading: authLoading, ready } = useRequireRole(["isFinance", "isBoardMember"]);
  const isFinance = !!user?.isFinance;

  const [classRows, setClassRows] = useState<ClassRow[]>([]);
  const [accountRows, setAccountRows] = useState<AccountRow[]>([]);
  const [classes, setClasses] = useState<Option[] | null>(null);
  const [accounts, setAccounts] = useState<Option[] | null>(null);

  const load = useCallback(() => Promise.all([
    request<{ BooksMapClass: ClassRow[]; BooksMapAccount: AccountRow[] }>("/api/books-map"),
    request<Option[]>("/api/budget-owners/quickbooks-classes"),
    request<Option[]>("/api/books-map/quickbooks-accounts"),
  ]).then(([map, c, a]) => {
    if (map.ok) { setClassRows(map.data.BooksMapClass); setAccountRows(map.data.BooksMapAccount); } else showError("Books map not loaded", map.error);
    if (c.ok) setClasses(c.data); else showError("QuickBooks Classes unavailable", c.error);
    if (a.ok) setAccounts(a.data); else showError("QuickBooks accounts unavailable", a.error);
  }), []);

  useEffect(() => { if (ready) void load(); }, [ready, load]);

  const save = async (url: string, body: unknown, failed: string) => {
    notifications.hide(failed);
    const res = await request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { showError(failed, res.error); return; }
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
        books to. Every lane reads these from here. {isFinance ? "Changes are recorded in the audit log." : "Finance edits them."}
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
