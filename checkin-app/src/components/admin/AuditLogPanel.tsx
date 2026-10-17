"use client";

import { useEffect, useState } from "react";
import { normalizeAuditData } from "@/lib/auditPayload";
import {
  Badge,
  Center,
  Code,
  Group,
  Loader,
  Pagination,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";

type AuditLog = {
  id: number;
  timestamp: string;
  actorId: number;
  actorName: string | null;
  actorSystem: string | null;
  action: "CREATE" | "EDIT" | "DELETE" | "BECOME_ADMIN";
  tableName: string;
  affectedEntityId: number;
  secondaryAffectedEntity: number | null;
  oldData: unknown;
  newData: unknown;
};

type AuditResponse = {
  logs: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
  tables: string[];
  actors: { id: number; name: string }[];
  systemActors: string[];
};

const ACTION_COLOR: Record<AuditLog["action"], string> = {
  CREATE: "green",
  EDIT: "blue",
  DELETE: "red",
  BECOME_ADMIN: "grape",
};

const ACTIONS = ["CREATE", "EDIT", "DELETE", "BECOME_ADMIN"];

export function AuditLogPanel() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<string | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const [actor, setActor] = useState<string | null>(null);
  const [entityId, setEntityId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    const qs = new URLSearchParams({ page: String(page) });
    if (action) qs.set("action", action);
    if (table) qs.set("table", table);
    if (actor) qs.set("actor", actor);
    if (entityId.trim()) qs.set("entityId", entityId.trim());
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);

    fetch(`/api/system-status/audit-log?${qs}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d) => {
        setData(d);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [page, action, table, actor, entityId, from, to]);

  // Filter changes reset to page 1.
  const onFilter =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setPage(1);
    };

  // People by name, then the named automated paths — one control over two columns
  // (a person's value is their id, a system path's value is its own name).
  const actorOptions = [
    ...(data?.actors ?? []).map((a) => ({ value: String(a.id), label: a.name })),
    ...(data?.systemActors ?? []).map((s) => ({ value: s, label: `System — ${s}` })),
  ];

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Stack gap="sm">
      <Group gap="sm" align="end">
        <Select
          label="Action"
          placeholder="All"
          clearable
          data={ACTIONS}
          value={action}
          onChange={onFilter(setAction)}
          w={150}
        />
        <Select
          label="Entity"
          placeholder="All"
          clearable
          searchable
          data={data?.tables ?? []}
          value={table}
          onChange={onFilter(setTable)}
          w={180}
        />
        <Select
          label="Actor"
          placeholder="Anyone"
          clearable
          searchable
          data={actorOptions}
          value={actor}
          onChange={onFilter(setActor)}
          w={220}
        />
        <TextInput
          label="Entity #"
          placeholder="id"
          type="number"
          value={entityId}
          onChange={(e) => onFilter(setEntityId)(e.currentTarget.value)}
          w={100}
        />
        <DateField label="From" value={from} onChange={onFilter(setFrom)} />
        <DateField label="To" value={to} onChange={onFilter(setTo)} />
      </Group>

      {failed ? (
        <Text c="red">Failed to load audit log.</Text>
      ) : !data ? (
        <Center mih="30vh">
          <Loader />
        </Center>
      ) : data.logs.length === 0 ? (
        <Text c="dimmed" size="sm">
          No audit entries match these filters.
        </Text>
      ) : (
        <>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {data.total} change{data.total === 1 ? "" : "s"} — forensic trail, read-only.
            </Text>
          </Group>
          <Table.ScrollContainer minWidth={760}>
            <Table striped highlightOnHover withTableBorder verticalSpacing={4} fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={110}>Time</Table.Th>
                  <Table.Th w={90}>Action</Table.Th>
                  <Table.Th>Entity</Table.Th>
                  <Table.Th>Actor</Table.Th>
                  <Table.Th>Changes</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.logs.map((l) => (
                  <Table.Tr key={l.id}>
                    <Table.Td style={{ whiteSpace: "nowrap" }}>
                      <div>{new Date(l.timestamp).toLocaleDateString()}</div>
                      <div>{new Date(l.timestamp).toLocaleTimeString()}</div>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="sm" color={ACTION_COLOR[l.action]}>
                        {l.action}
                      </Badge>
                    </Table.Td>
                    <Table.Td style={{ whiteSpace: "nowrap" }}>
                      {l.tableName} #{l.affectedEntityId}
                      {l.secondaryAffectedEntity != null && ` +${l.secondaryAffectedEntity}`}
                    </Table.Td>
                    <Table.Td style={{ whiteSpace: "nowrap" }}>
                      {l.actorSystem ? (
                        <Text span fz="xs" c="dimmed">
                          {l.actorSystem}
                        </Text>
                      ) : (
                        (l.actorName ?? (l.actorId === 0 ? "System" : `#${l.actorId}`))
                      )}
                    </Table.Td>
                    <Table.Td>
                      {l.oldData != null || l.newData != null ? (
                        <ScrollArea.Autosize mah={68} maw={420}>
                          <Code block fz="xs" style={{ background: "transparent" }}>
                            {JSON.stringify(
                              { old: normalizeAuditData(l.oldData), new: normalizeAuditData(l.newData) },
                              null,
                              2,
                            )}
                          </Code>
                        </ScrollArea.Autosize>
                      ) : (
                        <Text c="dimmed">—</Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          {totalPages > 1 && (
            <Group justify="center">
              <Pagination total={totalPages} value={page} onChange={setPage} size="sm" />
            </Group>
          )}
        </>
      )}
    </Stack>
  );
}

// Native date input dressed to match Mantine field spacing. ponytail: no
// @mantine/dates dependency for two plain date pickers.
function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Stack gap={2}>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          height: 36,
          borderRadius: 4,
          border: "1px solid var(--mantine-color-gray-4)",
          padding: "0 8px",
          fontSize: 14,
          background: "var(--mantine-color-body)",
          color: "var(--mantine-color-text)",
        }}
      />
    </Stack>
  );
}
