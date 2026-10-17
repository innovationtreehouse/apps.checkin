"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Anchor, Badge, Button, Checkbox, Group, Stack, Text, Tooltip } from "@mantine/core";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import { isProgramCheckoutBroken } from "@/lib/programCheckout";
import { formatDateOnly } from "@/lib/time";

type Program = {
  id: number;
  name: string;
  phase?: string;
  enrollmentStatus?: "OPEN" | "CLOSED";
  orgMemberOnly?: boolean;
  publiclyVisible?: boolean;
  startAt?: string | null;
  endAt?: string | null;
  orgMemberPriceCents?: number | null;
  nonOrgMemberPriceCents?: number | null;
  shopifyVariantId?: string | null;
  maxParticipants?: number | null;
  _count?: { participants?: number; events?: number };
};

const PHASE_LABELS: Record<string, string> = {
  PLANNING: "Planning",
  UPCOMING: "Upcoming",
  RUNNING: "Running",
  FINISHED: "Finished",
};
const PHASE_COLORS: Record<string, string> = {
  PLANNING: "yellow",
  UPCOMING: "blue",
  RUNNING: "green",
  FINISHED: "gray",
};

const fmtDate = (d?: string | null) =>
  d ? formatDateOnly(d, { month: "short", day: "numeric", year: "numeric" }) : null;

const dateRange = (p: Program) =>
  `${fmtDate(p.startAt)} – ${fmtDate(p.endAt)}`;

export default function AdminProgramsIndex() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeOnly, setActiveOnly] = useState(false);
  const [publicOnly, setPublicOnly] = useState(false);
  const router = useRouter();

  useEffect(() => {
    fetch('/api/programs')
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) {
          setPrograms(data);
        }
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to load programs:", err);
        setLoading(false);
      });
  }, []);

  const visiblePrograms = programs.filter(
    (p) =>
      (!activeOnly || p.phase !== "FINISHED") &&
      (!publicOnly || (p.phase !== "PLANNING" && (!p.orgMemberOnly || p.publiclyVisible))),
  );

  const columns: DataTableColumn<Program>[] = [
    {
      header: "Program",
      render: (p) => (
        <Group gap="xs" wrap="nowrap">
          <Text fw={600}>{p.name}</Text>
          {isProgramCheckoutBroken(p) && (
            <Tooltip label="Priced but no Shopify checkout variant — paid enrollment will not work. Open the program to sync.">
              <Badge color="red" variant="filled">⚠️ Broken checkout</Badge>
            </Tooltip>
          )}
        </Group>
      ),
      sortBy: (p) => p.name,
    },
    {
      header: "Dates",
      render: (p) => dateRange(p),
      sortBy: (p) => p.startAt ?? "",
    },
    {
      header: "Phase",
      render: (p) => (
        <Badge color={PHASE_COLORS[p.phase ?? ""] ?? "gray"} variant="light">
          {PHASE_LABELS[p.phase ?? ""] ?? p.phase ?? "—"}
        </Badge>
      ),
      sortBy: (p) => p.phase ?? "",
    },
    {
      header: "Enrollment",
      render: (p) => (
        <Badge color={p.enrollmentStatus === "OPEN" ? "treehouseGreen" : "gray"} variant="light">
          {p.enrollmentStatus === "OPEN" ? "Open" : "Closed"}
        </Badge>
      ),
      sortBy: (p) => p.enrollmentStatus ?? "CLOSED",
    },
    {
      header: "Participants",
      align: "right",
      render: (p) => `${p._count?.participants ?? 0}${p.maxParticipants != null ? `/${p.maxParticipants}` : ""}`,
      sortBy: (p) => p._count?.participants ?? 0,
    },
    {
      header: "Events",
      align: "right",
      render: (p) => p._count?.events ?? 0,
      sortBy: (p) => p._count?.events ?? 0,
    },
    {
      header: "Access",
      render: (p) => (
        <Badge color={p.orgMemberOnly ? 'grape' : 'blue'} variant="light">
          {p.orgMemberOnly ? 'Treehouse Members Only' : 'Public'}
        </Badge>
      ),
      sortBy: (p) => (p.orgMemberOnly ? 'Treehouse Members Only' : 'Public'),
    },
    {
      header: "",
      align: "right",
      render: (p) => (
        <Anchor component={Link} href={`/program-ops/programs/${p.id}`} fw={500}>
          View →
        </Anchor>
      ),
    },
  ];

  return (
    <Stack>
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Text c="dimmed">Manage recurring programs and curriculum tracks.</Text>
        <Button onClick={() => router.push('/program-ops/new')}>
          + New Program
        </Button>
      </Group>

      <Group gap="lg">
        <Checkbox
          label="Only show active"
          checked={activeOnly}
          onChange={(e) => setActiveOnly(e.currentTarget.checked)}
        />
        <Checkbox
          label="Only show programs available to the public"
          checked={publicOnly}
          onChange={(e) => setPublicOnly(e.currentTarget.checked)}
        />
      </Group>

      <DataTable
        columns={columns}
        rows={visiblePrograms}
        getRowKey={(p) => p.id}
        loading={loading}
        emptyMessage="No programs found. Create your first one!"
      />
    </Stack>
  );
}
