"use client";

import { useState } from "react";
import Link from "next/link";
import { Anchor, Box, Button, Center, Group, Loader, Select, Stack, Table, Text, TextInput } from "@mantine/core";
import { LoadError, useSetUrlFilters, useUrlFilter, useUrlPage } from "@checkin/component-ui";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useLoad } from "@/lib/api";
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
  const [page, setPage] = useUrlPage();
  const [person, setPerson] = useUrlFilter("person");
  const [kind, setKind] = useUrlFilter("kind");
  const [from, setFrom] = useUrlFilter("from");
  const [to, setTo] = useUrlFilter("to");
  const setFilters = useSetUrlFilters();
  // Typed text stays out of the URL; a change still starts again on page 1.
  const [record, setRecord] = useState("");

  const qs = new URLSearchParams({ page: String(page) });
  if (person) qs.set("person", person);
  if (kind) qs.set("kind", kind);
  if (record.trim()) qs.set("record", record.trim());
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  // Keeps the person filter's options and the rows on screen while the next page or filter loads.
  const { data, error, loading, retrying, reload } = useLoad<FinanceViewsResponse>(`/api/system-status/finance-views?${qs}`, { keepPrevious: true });
  const stale = loading || retrying;

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
          value={person || null}
          onChange={(v) => setPerson(v ?? "")}
          w={220}
        />
        <Select
          label="Record kind"
          placeholder="All"
          clearable
          data={KIND_OPTIONS}
          value={kind || null}
          onChange={(v) => setKind(v ?? "")}
          w={180}
        />
        <TextInput
          label="Record id"
          placeholder="id"
          value={record}
          onChange={(e) => {
            setRecord(e.currentTarget.value);
            if (page > 1) setFilters({});
          }}
          w={200}
        />
        <DateField label="From" value={from} onChange={setFrom} />
        <DateField label="To" value={to} onChange={setTo} />
      </Group>

      {error ? (
        <LoadError what="the finance view log" message={error} onRetry={reload} />
      ) : !data || (stale && rows.length === 0) ? (
        <Center mih="30vh">
          <Loader />
        </Center>
      ) : (
        <>
          {rows.length === 0 ? (
            <Text c="dimmed" size="sm">
              No finance views match these filters.
            </Text>
          ) : (
            <Box aria-busy={stale} style={{ opacity: stale ? 0.5 : 1 }}>
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
            </Box>
          )}
          {(page > 1 || hasNext) && (
            <Group justify="center">
              <Button variant="default" size="xs" disabled={stale || page === 1} onClick={() => setPage(page - 1)}>
                Newer
              </Button>
              <Text size="sm">Page {page}</Text>
              <Button variant="default" size="xs" disabled={stale || !hasNext} onClick={() => setPage(page + 1)}>
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
