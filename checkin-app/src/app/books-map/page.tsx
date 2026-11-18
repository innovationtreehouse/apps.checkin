"use client";

import type { ReactNode } from "react";
import { Select, Stack, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { InactivePickWarning, LoadError, QuickBooksListsRefresh, refusalMessage } from "@checkin/component-ui";
import type { BooksMapRole } from "@checkin/quickbooks";
import { BOOKS_MAP_ROLE_ACCOUNT_TYPES } from "@checkin/quickbooks/accountTypes";
import { PageLoader } from "@/components/ui/PageLoader";
import { useRequireRole } from "@/hooks/useRequireRole";
import { api, useLoad } from "@/lib/api";
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

interface AccountOption extends Option {
  accountType: string;
}

function showError(title: string, message: ReactNode) {
  notifications.hide(title);
  notifications.show({ id: title, color: "red", title, message, autoClose: false });
}

/** Options for a picker: active entries only; a saved inactive or missing one shows as a warning instead. */
function choices(options: Option[] | null) {
  return (options ?? []).filter((o) => o.active).map((o) => ({ value: o.id, label: o.name }));
}

/** A role's account options: only the types it accepts, plus the saved one marked when it is of another type. */
function accountChoices(options: AccountOption[] | null, role: BooksMapRole, saved: string | null) {
  const allowed = BOOKS_MAP_ROLE_ACCOUNT_TYPES[role];
  const fits = (options ?? []).filter((o) => allowed.includes(o.accountType) || o.id === saved);
  return choices(fits).map((c) => {
    const type = fits.find((o) => o.id === c.value)?.accountType;
    return type && !allowed.includes(type) ? { ...c, label: `${c.label} (wrong type: ${type})` } : c;
  });
}

export default function BooksMapPage() {
  const { user, loading: authLoading, ready } = useRequireRole(FINANCE_ROLES);
  const isFinance = !!user?.isFinance;

  const map = useLoad<{ BooksMapClass: ClassRow[]; BooksMapAccount: AccountRow[] }>(ready ? "/api/books-map" : null);
  const classes = useLoad<Option[]>(ready ? "/api/budget-owners/quickbooks-classes" : null);
  const accounts = useLoad<AccountOption[]>(ready ? "/api/books-map/quickbooks-accounts" : null);

  // A successful write re-reads every load on the page, so a save needs no reload of its own.
  const save = async (url: string, body: unknown, failed: string) => {
    notifications.hide(failed);
    try {
      await api(url, { method: "PUT", body: JSON.stringify(body) });
    } catch (e) {
      showError(failed, refusalMessage(e));
      return;
    }
    notifications.show({ message: "Saved." });
  };

  if (authLoading) return <PageLoader />;
  if (!ready) return null;

  return (
    <Stack>
      <Title order={2}>Books map</Title>
      <QuickBooksListsRefresh />
      <Text c="dimmed">
        Which QuickBooks account each kind of incoming money books to, and which QuickBooks Class each budget bucket
        books to. Income reads the Shopify and Benevity accounts and the Classes from here, gifts of goods read their four
        accounts and the Classes, and expenses read the Organisation card. Income books donation deposits from bulk uploads
        to the Benevity disbursements bank account below. {isFinance ? "Changes are recorded in the audit log." : "Finance edits them."}
      </Text>

      {classes.error && <LoadError what="QuickBooks Classes" message={classes.error} onRetry={classes.reload} />}
      {accounts.error && <LoadError what="QuickBooks accounts" message={accounts.error} onRetry={accounts.reload} />}
      {map.error ? (
        <LoadError what="the books map" message={map.error} onRetry={map.reload} />
      ) : !map.data ? (
        <PageLoader />
      ) : (
        <>
          <Title order={4}>Accounts</Title>
          <Table>
            <Table.Thead><Table.Tr><Table.Th>Role</Table.Th><Table.Th>QuickBooks account</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {map.data.BooksMapAccount.map((r) => (
                <Table.Tr key={r.role}>
                  <Table.Td>{BOOKS_MAP_ROLE_LABELS[r.role] ?? r.role}</Table.Td>
                  <Table.Td>
                    <Select
                      aria-label={BOOKS_MAP_ROLE_LABELS[r.role] ?? r.role}
                      data={accountChoices(accounts.data, r.role, r.quickBooksAccountId)}
                      value={r.quickBooksAccountId}
                      placeholder="Not set"
                      searchable
                      clearable
                      disabled={!isFinance}
                      onChange={(v) => void save(`/api/books-map/accounts/${r.role}`, { quickBooksAccountId: v }, "Account not saved")}
                    />
                    <InactivePickWarning saved={r.quickBooksAccountId} options={accounts.data} advice="Pick an active one." />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          <Title order={4}>Classes</Title>
          <Table>
            <Table.Thead><Table.Tr><Table.Th>Bucket</Table.Th><Table.Th>QuickBooks Class</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {map.data.BooksMapClass.map((r) => (
                <Table.Tr key={r.budgetOwnerId}>
                  <Table.Td>{r.budgetOwnerName}</Table.Td>
                  <Table.Td>
                    <Select
                      aria-label={`Class for ${r.budgetOwnerName}`}
                      data={choices(classes.data)}
                      value={r.quickBooksClassId}
                      placeholder="Not set"
                      searchable
                      disabled={!isFinance}
                      onChange={(v) => void save(`/api/books-map/classes/${r.budgetOwnerId}`, { quickBooksClassId: v }, "Class not saved")}
                    />
                    <InactivePickWarning saved={r.quickBooksClassId} options={classes.data} advice="Pick an active one." />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}
    </Stack>
  );
}
