"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { Anchor, Box, Button, Center, Group, Loader, Select, Stack, Table, Text, TextInput } from "@mantine/core";
import { LoadError, useSetUrlFilters, useUrlBefore, useUrlFilter } from "@checkin/component-ui";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useLoad } from "@/lib/api";
import { FINANCE_VIEWS_ROLES } from "@/lib/nav/sections/systemStatus";
import {
  FINANCE_VIEWS_PAGE_SIZE,
  FINANCE_VIEW_MODELS,
  financeViewCursor,
  financeViewPlace,
  financeViewRecordHref,
  financeViewRecords,
  financeViewTime,
  financeViewViewer,
  isFinanceViewModel,
  type FinanceViewRow,
} from "@/lib/finance/financeViewKinds";

interface FinanceViewsResponse {
  FinanceViewLog: FinanceViewRow[];
  Person: { id: number; name: string }[];
}

const KIND_OPTIONS = FINANCE_VIEW_MODELS.map((m) => ({ value: m, label: m }));

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
  const [before, setBefore] = useUrlBefore();
  const [person, setPerson] = useUrlFilter("person");
  const [kind, setKind] = useUrlFilter("kind");
  const [from, setFrom] = useUrlFilter("from");
  const [to, setTo] = useUrlFilter("to");
  const setFilters = useSetUrlFilters();
  // Typed text stays out of the URL; a change still starts again on page 1.
  const [record, setRecord] = useState("");

  const qs = new URLSearchParams();
  if (before) qs.set("before", before);
  if (person) qs.set("person", person);
  if (isFinanceViewModel(kind)) qs.set("kind", kind);
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
  const hasOlder = (data?.FinanceViewLog.length ?? 0) > FINANCE_VIEWS_PAGE_SIZE;
  const last = rows[rows.length - 1];

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Who viewed finance records, newest first. Visible to the Board only.
      </Text>
      <Text size="xs" c="dimmed">
        Each record is named as Model:id (Expense:e_123), with the sensitive fields the viewer was sent.
        Rows from before page views name bare ids, which the record type filter does not match.
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
          label="Record type"
          placeholder="All"
          clearable
          searchable
          data={KIND_OPTIONS}
          value={isFinanceViewModel(kind) ? kind : null}
          onChange={(v) => setKind(v ?? "")}
          w={220}
        />
        <TextInput
          label="Record id"
          placeholder="id or Model:id"
          value={record}
          onChange={(e) => {
            setRecord(e.currentTarget.value);
            if (before) setFilters({});
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
                      <Entry row={row} name={names.get(row.actorId)} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            </Box>
          )}
          {(before || hasOlder) && (
            <Group justify="center">
              <Button variant="default" size="xs" disabled={stale || !before} onClick={() => setBefore("")}>
                Newest
              </Button>
              <Button
                variant="default"
                size="xs"
                disabled={stale || !hasOlder || !last}
                onClick={() => last && setBefore(financeViewCursor(last))}
              >
                Older
              </Button>
            </Group>
          )}
        </>
      )}
    </Stack>
  );
}

/** "Pat Lee (Finance) viewed Expense:e_1 (submitterId), Receipt:r_9 on /expense/expenses/e_1, 6 Nov 2026 14:05". */
function Entry({ row, name }: { row: FinanceViewRow; name: string | undefined }) {
  const records = financeViewRecords(row);
  const place = financeViewPlace(row);
  return (
    <Text size="sm">
      {financeViewViewer(row, name)} viewed{" "}
      {records.length === 0
        ? "no named record"
        : records.map((r, i) => (
            <Fragment key={r.ref}>
              {i > 0 && ", "}
              <RecordRef recordRef={r.ref} />
              {r.fields.length > 0 && ` (${r.fields.join(", ")})`}
            </Fragment>
          ))}
      {place && ` ${place}`}, {financeViewTime(row)}
    </Text>
  );
}

/** A record links to its page where the app has one, and is plain text otherwise. */
function RecordRef({ recordRef }: { recordRef: string }) {
  const href = financeViewRecordHref(recordRef);
  return href ? (
    <Anchor component={Link} href={href} inherit>
      {recordRef}
    </Anchor>
  ) : (
    <>{recordRef}</>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <TextInput label={label} type="date" value={value} onChange={(e) => onChange(e.currentTarget.value)} w={160} />
  );
}
