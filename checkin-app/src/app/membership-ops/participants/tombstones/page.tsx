"use client";

import { useState, useEffect } from "react";
import { Badge, Group, Stack, Table, Text, Title, Tooltip } from "@mantine/core";
import { AlertBanner } from "@/components/admin/AlertBanner";
import { useRequireRole } from "@/hooks/useRequireRole";
import { PageLoader } from "@/components/ui/PageLoader";

interface Residue {
  key: string;
  label: string;
  disposition: "route" | "cascade" | "none";
  hint?: string;
  count: number;
}

interface Tombstone {
  id: number;
  name?: string | null;
  email?: string | null;
  survivorId: number | null;
  survivorName: string | null;
  hasArchive: boolean;
  residue: Residue[];
  noPathwayRows: number;
}

interface Census {
  tombstones: Tombstone[];
  totals: { tombstones: number; withResidue: number; withoutArchive: number; noPathwayRows: number };
}

const DISPOSITION_COLOR: Record<Residue["disposition"], string> = {
  route: "blue",
  cascade: "orange",
  none: "red",
};

const DISPOSITION_TOOLTIP: Record<Residue["disposition"], string> = {
  route: "Self-serve cleanup exists",
  cascade: "Cascades on delete — removed silently (data loss, not resolution)",
  none: "No self-serve pathway — resolve in the DB or build a route",
};

export default function TombstoneCensus() {
  const { ready, loading: authLoading } = useRequireRole(["isSysadmin", "isBoardMember"]);
  const [census, setCensus] = useState<Census | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    fetch("/api/membership-ops/participants/tombstones")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to load census."))))
      .then(setCensus)
      .catch((e) => setError(e.message));
  }, [ready]);

  if (authLoading || !ready) return <PageLoader />;

  return (
    <Stack>
      <Title order={2}>Tombstone census (#1456 §2a)</Title>
      <Text c="dimmed" size="sm">
        Merged-away Person rows and the residue parked on them. A tombstone is
        delete-safe once it has an archive row and no <b>red</b> (no-pathway) or{" "}
        <b>orange</b> (cascade / silent-loss) residue. Read-only — resolve via the
        linked surfaces, then re-check here.
      </Text>

      {error && <AlertBanner tone="error" message={error} />}

      {census && (
        <>
          <Group gap="xl">
            <Stat label="Tombstones" value={census.totals.tombstones} />
            <Stat label="With residue" value={census.totals.withResidue} />
            <Stat label="Missing archive" value={census.totals.withoutArchive} danger={census.totals.withoutArchive > 0} />
            <Stat label="No-pathway rows" value={census.totals.noPathwayRows} danger={census.totals.noPathwayRows > 0} />
          </Group>

          {census.tombstones.length === 0 ? (
            <AlertBanner tone="success" message="No tombstones. LIVE_PERSON has nothing left to exclude." />
          ) : (
            <Table striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Tombstone</Table.Th>
                  <Table.Th>Merged into</Table.Th>
                  <Table.Th>Archive</Table.Th>
                  <Table.Th>Parked residue</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {census.tombstones.map((t) => (
                  <Table.Tr key={t.id}>
                    <Table.Td>
                      <Text size="sm">{t.name || "—"}</Text>
                      <Text size="xs" c="dimmed">#{t.id} · {t.email || "no email"}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{t.survivorName || "—"}</Text>
                      {t.survivorId != null && <Text size="xs" c="dimmed">#{t.survivorId}</Text>}
                    </Table.Td>
                    <Table.Td>
                      {t.hasArchive
                        ? <Badge color="green" variant="light">archived</Badge>
                        : <Badge color="red" variant="light">no archive</Badge>}
                    </Table.Td>
                    <Table.Td>
                      {t.residue.length === 0
                        ? <Text size="xs" c="dimmed">clean</Text>
                        : (
                          <Group gap={6}>
                            {t.residue.map((r) => (
                              <Tooltip
                                key={r.key}
                                label={`${r.hint ?? DISPOSITION_TOOLTIP[r.disposition]}${r.disposition === "route" ? "" : ` — ${DISPOSITION_TOOLTIP[r.disposition]}`}`}
                                multiline
                                w={260}
                              >
                                <Badge color={DISPOSITION_COLOR[r.disposition]} variant="light">
                                  {r.label}: {r.count}
                                </Badge>
                              </Tooltip>
                            ))}
                          </Group>
                        )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </>
      )}
    </Stack>
  );
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <Stack gap={0}>
      <Text size="xl" fw={700} c={danger ? "red" : undefined}>{value}</Text>
      <Text size="xs" c="dimmed">{label}</Text>
    </Stack>
  );
}
