"use client";

import { useState, useMemo } from "react";
import { Badge, Card, Chip, Group, Stack, Text, TextInput } from "@mantine/core";
import { LoadError } from "@checkin/component-ui";
import { useLoad } from "@/lib/api";
import { formatDateOnly } from "@/lib/time";
import { PageLoader } from "@/components/ui/PageLoader";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";

type Attestation = {
  id: number;
  result: "APPROVE" | "REJECT";
  createdAt: string;
  reviewer: { id: number; name: string | null };
  subjectPerson: { id: number; name: string | null } | null;
  process: {
    id: number;
    kind: string;
    status: string;
    bgClearedAt: string | null;
    subjectPerson: { id: number; name: string | null; householdId: number; household: { id: number; name: string | null } | null } | null;
    orgMembership: { household: { id: number; name: string | null } | null } | null;
  };
};

const KIND_LABEL: Record<string, string> = {
  INITIAL: "Initial",
  RENEWAL: "Renewal",
  PERSON_BG: "Individual",
};

function subjectLabel(a: Attestation): string | null {
  const subject = a.process.kind === "PERSON_BG"
    ? a.process.subjectPerson
    : a.subjectPerson;
  if (!subject) return null;
  return subject.name || `Person #${subject.id}`;
}

function householdLabel(a: Attestation): string | null {
  const household = a.process.kind === "PERSON_BG"
    ? a.process.subjectPerson?.household ?? null
    : a.process.orgMembership?.household ?? null;
  if (!household) return null;
  return household.name || `Household #${household.id}`;
}

type Status = "CLEARED" | "BLOCKED" | "PENDING";

const STATUS_BADGE: Record<Status, { label: string; color: string }> = {
  CLEARED: { label: "Cleared", color: "green" },
  BLOCKED: { label: "Blocked", color: "red" },
  PENDING: { label: "Pending", color: "gray" },
};

function statusOf(a: Attestation): Status {
  if (a.process.bgClearedAt) return "CLEARED";
  return a.process.status === "BLOCKED" ? "BLOCKED" : "PENDING";
}

const reviewerLabel = (a: Attestation) => a.reviewer.name || `Person #${a.reviewer.id}`;
const kindLabel = (a: Attestation) => KIND_LABEL[a.process.kind] ?? a.process.kind;
const dimDash = <Text span c="dimmed">—</Text>;

const COLUMNS: DataTableColumn<Attestation>[] = [
  {
    header: "Date",
    render: (a) => <Text span style={{ whiteSpace: "nowrap" }}>{formatDateOnly(a.createdAt)}</Text>,
    sortBy: (a) => a.createdAt,
  },
  { header: "Reviewer", render: reviewerLabel, sortBy: reviewerLabel },
  { header: "Subject", render: (a) => subjectLabel(a) || dimDash, sortBy: subjectLabel },
  { header: "Household", render: (a) => householdLabel(a) || dimDash, sortBy: householdLabel },
  { header: "Type", render: kindLabel, sortBy: kindLabel },
  {
    header: "Result",
    render: (a) => (
      <Badge color={a.result === "APPROVE" ? "green" : "red"} variant="light" size="sm">
        {a.result === "APPROVE" ? "Approved" : "Rejected"}
      </Badge>
    ),
    sortBy: (a) => a.result,
  },
  {
    header: "Status",
    render: (a) => {
      const { label, color } = STATUS_BADGE[statusOf(a)];
      return <Badge color={color} variant="light" size="sm">{label}</Badge>;
    },
    sortBy: statusOf,
  },
];

export default function BgAttestationsPage() {
  const { data, error, reload } = useLoad<Attestation[]>("/api/membership-audit/bg-attestations");
  const [search, setSearch] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [results, setResults] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);

  const attestations = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return attestations.filter((a) => {
      if (kinds.length > 0 && !kinds.includes(a.process.kind)) return false;
      if (results.length > 0 && !results.includes(a.result)) return false;
      if (statuses.length > 0 && !statuses.includes(statusOf(a))) return false;
      if (!q) return true;
      return [reviewerLabel(a), subjectLabel(a), householdLabel(a)]
        .some((v) => v?.toLowerCase().includes(q));
    });
  }, [attestations, search, kinds, results, statuses]);

  if (error) return <LoadError what="attestation data" message={error} onRetry={reload} />;
  if (!data) return <PageLoader />;

  return (
    <Stack>
      <Card withBorder radius="md" padding="lg">
        <Text c="dimmed">
          Every background-check attestation on record — who reviewed, who was checked, and the
          outcome. Newest first; click a column header to sort.
        </Text>
      </Card>

      <Group gap="sm" wrap="wrap" align="flex-end">
        <TextInput
          w={280}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="Search reviewer, subject, or household"
          aria-label="Search attestations"
        />
        <Chip.Group multiple value={kinds} onChange={setKinds}>
          <Group gap="xs">
            {Object.entries(KIND_LABEL).map(([value, label]) => (
              <Chip key={value} value={value} size="sm" variant="outline">{label}</Chip>
            ))}
          </Group>
        </Chip.Group>
        <Chip.Group multiple value={results} onChange={setResults}>
          <Group gap="xs">
            <Chip value="APPROVE" color="green" size="sm" variant="outline">Approved</Chip>
            <Chip value="REJECT" color="red" size="sm" variant="outline">Rejected</Chip>
          </Group>
        </Chip.Group>
        <Chip.Group multiple value={statuses} onChange={setStatuses}>
          <Group gap="xs">
            {(Object.keys(STATUS_BADGE) as Status[]).map((value) => (
              <Chip key={value} value={value} color={STATUS_BADGE[value].color} size="sm" variant="outline">
                {STATUS_BADGE[value].label}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      </Group>

      <DataTable
        columns={COLUMNS}
        rows={visible}
        getRowKey={(a) => a.id}
        emptyMessage={attestations.length === 0 ? "No attestations on record." : "No attestations match this filter."}
      />
    </Stack>
  );
}
