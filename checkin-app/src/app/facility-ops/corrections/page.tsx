"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Group, SegmentedControl, Stack, Switch, Table, Text } from "@mantine/core";
import { useRequireRole } from "@/hooks/useRequireRole";
import { FACILITY_RECORD_ROLES } from "@/lib/nav/sections/facilityOps";
import { PageLoader } from "@/components/ui/PageLoader";
import { useOrgTime } from '@/components/TimezoneProvider';
import { MAX_ROWS } from "@/lib/corrections";
import { SYSTEM_ACTOR } from "@/lib/auditActor";
import type { PeriodType } from "@/lib/timePeriods";

type AuditAction = "CREATE" | "EDIT" | "DELETE" | "BECOME_ADMIN";

type VisitPick = {
  id?: number;
  personId?: number;
  arrivedAt?: string | null;
  departedAt?: string | null;
  arrivedVia?: string | null;
  departedVia?: string | null;
  associatedEventId?: number | null;
} | null;

type AuditRow = {
  id: number;
  timestamp: string;
  actorId: number;
  actorSystem: string | null;
  action: AuditAction;
  tableName: string;
  affectedEntityId: number;
  secondaryAffectedEntity: number | null;
  newData: { type?: string; significance?: { score: number; flagged: boolean } };
};

type PersonRef = { id: number; name: string | null; mergedIntoId: number | null };

type Payload = { AuditLog: AuditRow[]; Person: PersonRef[]; Visit: VisitPick[][] };

const TYPE_LABEL: Record<string, string> = {
  manual_entry: "Manual entry",
  self_correction: "Self correction",
  staff_entry: "Staff entry",
  lead_attendance_correction: "Attendance correction",
  staff_correction: "Staff correction",
  staff_removal: "Staff removal",
  conflict_resolution: "Conflict resolution",
};

// `newData.type` names the ROUTE, not the actor relationship — a household lead
// correcting a member still writes "self_correction". It's a label here, never
// the self/proxy axis; see actorClass below for that.
// Governing rules: docs/rules/attendance-checkin.md, "The visit record".
function kindLabel(row: AuditRow): string {
  if (row.newData.type && TYPE_LABEL[row.newData.type]) return TYPE_LABEL[row.newData.type];
  switch (row.action) {
    case "CREATE": return "Insert";
    case "EDIT": return "Edit";
    case "DELETE": return "Delete";
    default: return row.action;
  }
}

// The actor axis is a bare comparison: actorId vs the subject stored in
// secondaryAffectedEntity, an invariant every visit audit write holds
// (docs/rules/attendance-checkin.md). `null` is a row written before the
// invariant held everywhere — shown as unknown, never guessed at. A system
// write is on neither side of the axis: nobody edited anybody.
function actorClass(row: AuditRow): "self" | "proxy" | "system" | "unknown" {
  if (row.actorId === SYSTEM_ACTOR) return "system";
  if (row.secondaryAffectedEntity == null) return "unknown";
  return row.actorId === row.secondaryAffectedEntity ? "self" : "proxy";
}

// SYSTEM_ACTOR is a sentinel, so it resolves to no Person and must never fall
// through to "Person #0". actorSystem names which automated path wrote the row.
function actorName(row: AuditRow, people: Map<number, PersonRef>): string {
  if (row.actorId === SYSTEM_ACTOR) return row.actorSystem ?? "System";
  return nameFor(row.actorId, people);
}

function nameFor(id: number | null, people: Map<number, PersonRef>): string {
  if (id == null) return "—";
  const p = people.get(id);
  if (!p) return `Person #${id}`;
  return p.mergedIntoId ? `${p.name ?? `Person #${id}`} (merged)` : p.name ?? `Person #${id}`;
}

// A key ABSENT from the pick (vs. present-but-null) means the writer never
// touched that field — render "—", never infer a value: arrivedVia and
// departedVia are not stamped onto a self-correction's newData.
function VisitTimes({ v }: { v: VisitPick }) {
  const { formatDateTime } = useOrgTime();
  if (!v || (!("arrivedAt" in v) && !("departedAt" in v))) {
    return <Text c="dimmed" size="sm">—</Text>;
  }
  return (
    <Stack gap={2}>
      {"arrivedAt" in v && (
        <Text size="sm">In: {v.arrivedAt ? formatDateTime(v.arrivedAt) : "—"}</Text>
      )}
      {"departedAt" in v && (
        <Text size="sm">Out: {v.departedAt ? formatDateTime(v.departedAt) : "—"}</Text>
      )}
    </Stack>
  );
}

// A row with no significance was never scored — a create, or a writer that
// predates scoring. That is NOT the same as "reviewed and found insignificant",
// so it gets its own muted label.
function ScoreBadge({ sig }: { sig?: { score: number; flagged: boolean } }) {
  if (!sig) return <Text c="dimmed" size="sm">Not scored</Text>;
  return sig.flagged
    ? <Badge color="red" variant="light">Flagged · {sig.score}</Badge>
    : <Badge color="gray" variant="light">{sig.score}</Badge>;
}

function ActorBadge({ cls }: { cls: "self" | "proxy" | "system" | "unknown" }) {
  if (cls === "self") return <Badge color="gray" variant="light">Self</Badge>;
  if (cls === "proxy") return <Badge color="orange" variant="light">Proxy</Badge>;
  if (cls === "system") return <Badge color="blue" variant="light">System</Badge>;
  return <Text c="dimmed" size="sm">—</Text>;
}

export default function CorrectionsPage() {
  const { formatDateTime } = useOrgTime();
  const { ready, loading: authLoading } = useRequireRole(FACILITY_RECORD_ROLES);

  const [period, setPeriod] = useState<PeriodType>("month");
  // Defaults to the significant changes (executive summary); the full feed
  // is one switch away.
  const [flaggedOnly, setFlaggedOnly] = useState(true);
  const [data, setData] = useState<Payload | null>(null);
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const [error, setError] = useState("");

  // Loading is derived, not stored: the data on hand either belongs to the
  // current query or a fetch for it is still in flight.
  const query = `${period}|${flaggedOnly}`;
  const loading = loadedQuery !== query;

  useEffect(() => {
    if (!ready) return;
    // `live` drops a response the user has already filtered past. Without it a
    // slow earlier request settles last and leaves loadedQuery on the old query,
    // so the derived flag latches loading with no fetch pending.
    let live = true;
    const params = new URLSearchParams({ period, flagged: String(flaggedOnly) });
    fetch(`/api/facility/corrections?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error("request failed");
        return res.json();
      })
      .then((body: Payload) => { if (live) { setData(body); setError(""); } })
      .catch(() => { if (live) { setData(null); setError("Failed to load corrections."); } })
      .finally(() => { if (live) setLoadedQuery(query); });
    return () => { live = false; };
  }, [ready, period, flaggedOnly, query]);

  const people = useMemo(() => new Map((data?.Person ?? []).map((p) => [p.id, p])), [data]);

  if (authLoading) return <PageLoader />;
  if (!ready) return null;

  const allRows = data?.AuditLog ?? [];
  const allVisits = data?.Visit ?? [];
  const overflowed = allRows.length > MAX_ROWS;
  const rows = overflowed ? allRows.slice(0, MAX_ROWS) : allRows;
  const visits = overflowed ? allVisits.slice(0, MAX_ROWS) : allVisits;

  return (
    <Stack>
      <Text c="dimmed">
        Attendance corrections read off the audit trail — self and staff edits, deletes and
        manual entries. Nothing here is stored separately; this is a view, not a queue.
      </Text>

      <Group justify="space-between" wrap="wrap">
        <SegmentedControl
          value={period}
          onChange={(v) => setPeriod(v as PeriodType)}
          data={[
            { label: "Week", value: "week" },
            { label: "Month", value: "month" },
            { label: "Quarter", value: "quarter" },
            { label: "Year", value: "year" },
          ]}
        />
        <Switch
          label="Flagged only"
          checked={flaggedOnly}
          onChange={(e) => setFlaggedOnly(e.currentTarget.checked)}
        />
      </Group>

      {error && <Alert color="red">{error}</Alert>}

      {overflowed && (
        <Alert color="yellow" variant="light">
          More than {MAX_ROWS} corrections in this range — showing the most recent {MAX_ROWS}.
          Narrow the period to see the rest.
        </Alert>
      )}

      {/* The loader comes first so a retry after a failure still shows progress —
          `error` survives until the next success, and gating it away with the
          rest left a stale alert and nothing moving. On error the result is
          suppressed entirely: a count of zero and "No corrections in this range"
          are both assertions about a period that was never read. */}
      {loading && rows.length === 0 ? (
        <PageLoader />
      ) : !error ? (
        <>
        {/* The range runs from the start of the chosen period to now, so the
            count describes "this week/month/quarter/year". Counted over the
            whole result because v1 does not paginate; past MAX_ROWS the
            server's +1 probe makes it a floor, shown as "500+". */}
        <Text size="sm" fw={500}>
          {overflowed ? `${MAX_ROWS}+` : rows.length}{" "}
          {flaggedOnly ? "flagged " : ""}
          correction{!overflowed && rows.length === 1 ? "" : "s"} this {period}
        </Text>
        <Table.ScrollContainer minWidth={900}>
          <Table verticalSpacing="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>When</Table.Th>
                <Table.Th>Kind</Table.Th>
                <Table.Th>Actor</Table.Th>
                <Table.Th>Subject</Table.Th>
                <Table.Th>Before</Table.Th>
                <Table.Th>After</Table.Th>
                <Table.Th>Score</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={7} ta="center">
                    <Text c="dimmed" py="md">No corrections in this range.</Text>
                  </Table.Td>
                </Table.Tr>
              ) : (
                rows.map((r, i) => {
                  const cls = actorClass(r);
                  const [before, after] = visits[i] ?? [null, null];
                  return (
                    <Table.Tr key={r.id}>
                      <Table.Td>{formatDateTime(r.timestamp)}</Table.Td>
                      <Table.Td>{kindLabel(r)}</Table.Td>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <span>{actorName(r, people)}</span>
                          <ActorBadge cls={cls} />
                        </Group>
                      </Table.Td>
                      <Table.Td>{nameFor(r.secondaryAffectedEntity, people)}</Table.Td>
                      <Table.Td><VisitTimes v={before} /></Table.Td>
                      <Table.Td><VisitTimes v={after} /></Table.Td>
                      <Table.Td><ScoreBadge sig={r.newData.significance} /></Table.Td>
                    </Table.Tr>
                  );
                })
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        </>
      ) : null}
    </Stack>
  );
}
