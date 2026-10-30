"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Anchor, Button, Center, Group, Loader, Select, Stack, Table, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useRequireRole } from "@/hooks/useRequireRole";
import { FINANCE_VIEWS_ROLES } from "@/lib/nav/sections/systemStatus";
import {
  FINANCE_VIEWS_PAGE_SIZE,
  FINANCE_VIEW_KINDS,
  financeViewRecordHref,
  financeViewSentence,
  type FinanceViewRow,
} from "@/lib/finance/financeViewKinds";

interface FinanceViewsResponse {
  FinanceViewLog: FinanceViewRow[];
  Person: { id: number; name: string }[];
}

const KIND_OPTIONS = FINANCE_VIEW_KINDS.map((k) => ({ value: k.key, label: k.label }));

// The /system-status layout admits sysadmins too; this tab is the Board's alone (B11).
export default function FinanceViewsPage() {
  const { loading, ready } = useRequireRole(FINANCE_VIEWS_ROLES, { redirectTo: "/system-status" });
  if (loading) {
    return (
      <Center mih="30vh">
        <Loader />
      </Center>
    );
  }
  if (!ready) return null;
  return <FinanceViewsPanel />;
}

function FinanceViewsPanel() {
  const [data, setData] = useState<FinanceViewsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const [person, setPerson] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [record, setRecord] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    const qs = new URLSearchParams({ page: String(page) });
    if (person) qs.set("person", person);
    if (kind) qs.set("kind", kind);
    if (record.trim()) qs.set("record", record.trim());
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);

    let cancelled = false;
    fetch(`/api/system-status/finance-views?${qs}`)
      .then(async (res) => {
        if (!res.ok) {
          const body: { error?: string } = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<FinanceViewsResponse>;
      })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setFailed(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setFailed(true);
        notifications.show({
          color: "red",
          title: "Couldn't load the finance view log",
          message: err.message,
          autoClose: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [page, person, kind, record, from, to]);

  // Filter changes reset to page 1.
  const onFilter =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setPage(1);
    };

  const names = new Map((data?.Person ?? []).map((p) => [p.id, p.name]));
  const personOptions = (data?.Person ?? [])
    .map((p) => ({ value: String(p.id), label: p.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const rows = (data?.FinanceViewLog ?? []).slice(0, FINANCE_VIEWS_PAGE_SIZE);
  const hasNext = (data?.FinanceViewLog.length ?? 0) > FINANCE_VIEWS_PAGE_SIZE;

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Who viewed finance records, newest first. Visible to the Board only.
      </Text>
      <Group gap="sm" align="end">
        <Select
          label="Person"
          placeholder="Anyone"
          clearable
          searchable
          data={personOptions}
          value={person}
          onChange={onFilter(setPerson)}
          w={220}
        />
        <Select
          label="Record kind"
          placeholder="All"
          clearable
          data={KIND_OPTIONS}
          value={kind}
          onChange={onFilter(setKind)}
          w={180}
        />
        <TextInput
          label="Record id"
          placeholder="id"
          value={record}
          onChange={(e) => onFilter(setRecord)(e.currentTarget.value)}
          w={200}
        />
        <DateField label="From" value={from} onChange={onFilter(setFrom)} />
        <DateField label="To" value={to} onChange={onFilter(setTo)} />
      </Group>

      {failed && !data ? null : !data ? (
        <Center mih="30vh">
          <Loader />
        </Center>
      ) : rows.length === 0 ? (
        <Text c="dimmed" size="sm">
          No finance views match these filters.
        </Text>
      ) : (
        <>
          <Table striped withTableBorder verticalSpacing={6} fz="sm">
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.id}>
                  <Table.Td>
                    <Text size="sm">{financeViewSentence(row, names.get(row.actorId))}</Text>
                    {row.recordIds.length > 0 && <RecordIds row={row} />}
                    <Text size="xs" c="dimmed">
                      {row.endpoint}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {(page > 1 || hasNext) && (
            <Group justify="center">
              <Button variant="default" size="xs" disabled={page === 1} onClick={() => setPage(page - 1)}>
                Newer
              </Button>
              <Text size="sm">Page {page}</Text>
              <Button variant="default" size="xs" disabled={!hasNext} onClick={() => setPage(page + 1)}>
                Older
              </Button>
            </Group>
          )}
        </>
      )}
    </Stack>
  );
}

function RecordIds({ row }: { row: FinanceViewRow }) {
  return (
    <Group gap={6} wrap="wrap">
      {row.recordIds.map((id) => {
        const href = financeViewRecordHref(row, id);
        return href ? (
          <Anchor key={id} component={Link} href={href} size="xs">
            {id}
          </Anchor>
        ) : (
          <Text key={id} span size="xs">
            {id}
          </Text>
        );
      })}
    </Group>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <TextInput label={label} type="date" value={value} onChange={(e) => onChange(e.currentTarget.value)} w={160} />
  );
}
