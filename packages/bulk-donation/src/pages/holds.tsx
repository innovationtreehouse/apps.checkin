"use client";
import { useState } from "react";
import { Button, Group, Modal, Paper, Stack, Table, Text, Title } from "@mantine/core";
import { act, api, paged, useCanWrite, useLoad } from "../components/api";
import { LoadError, Pager } from "@checkin/component-ui";

interface AccountRule { id: number; companyName: string; corporatePeerCampaign: string }
interface HoldRow {
  id: number;
  disbursementId: string;
  reason: string;
  matchedRows: AccountRule[];
  transaction: { companyName: string | null; corporatePeerCampaign: string | null; donationMethod: string | null; donationType: string | null } | null;
}

/** Each hold reason as finance reads it. */
const REASON: Record<string, string> = {
  NO_MATCH: "No rule matches",
  MULTIPLE_MATCHES: "Several rules match",
  NO_ACCOUNT: "Rule has no QuickBooks account for this gift's amount",
  FEES_ONLY: "Row has fees but no donation or match to take them from",
};

/** /donations/holds — disbursements whose gifts match zero or several account rules, a rule without the account a gift needs, or a row with fees and no amount. */
export default function HoldsPage() {
  const canWrite = useCanWrite();
  const [page, setPage] = useState(1);
  const [releasing, setReleasing] = useState<HoldRow | null>(null);
  const holds = useLoad<HoldRow[]>(paged("/disbursement-holds", page), { keepPrevious: true });
  const groups = new Map<string, HoldRow[]>();
  for (const h of holds.data ?? []) groups.set(h.disbursementId, [...(groups.get(h.disbursementId) ?? []), h]);

  return (
    <>
      <Title order={3} mb="md">Disbursement holds</Title>
      <Text size="sm" c="dimmed" mb="md">Fix the account map, then resubmit the disbursement.</Text>
      {holds.error && <LoadError what="holds" message={holds.error} onRetry={holds.reload} />}
      {holds.data?.length === 0 && <Text c="dimmed">No holds.</Text>}
      <Stack>
        {[...groups].map(([disbursementId, rows]) => (
          <Paper key={disbursementId} withBorder p="md" radius="md">
            <Group justify="space-between" mb="sm">
              <Text fw={600}>Disbursement {disbursementId}</Text>
              {canWrite && (
                <Button size="xs" onClick={() => act(
                  () => api(`/disbursement-holds/${encodeURIComponent(disbursementId)}/resubmit`, { method: "POST" }),
                  "Resubmitted", holds.reload,
                )}>Resubmit</Button>
              )}
            </Group>
            {rows.some((h) => h.reason === "FEES_ONLY") && (
              <Text size="sm" c="dimmed" mb="sm">
                Book the fee by hand in QuickBooks, then release the row: its fee drops out of the automated booking and the rest of the disbursement posts.
              </Text>
            )}
            <Table>
              <Table.Thead>
                <Table.Tr><Table.Th>Reason</Table.Th><Table.Th>Company</Table.Th><Table.Th>Campaign</Table.Th><Table.Th>Method / type</Table.Th><Table.Th>Matched rules</Table.Th>{canWrite && <Table.Th />}</Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((h) => (
                  <Table.Tr key={h.id}>
                    <Table.Td>{REASON[h.reason] ?? h.reason}</Table.Td>
                    <Table.Td>{h.transaction?.companyName ?? "—"}</Table.Td>
                    <Table.Td>{h.transaction?.corporatePeerCampaign ?? "—"}</Table.Td>
                    <Table.Td>{[h.transaction?.donationMethod, h.transaction?.donationType].filter(Boolean).join(" / ") || "—"}</Table.Td>
                    <Table.Td>{h.matchedRows.map((r) => `#${r.id} ${r.companyName} / ${r.corporatePeerCampaign}`).join("; ") || "none"}</Table.Td>
                    {canWrite && (
                      <Table.Td>
                        {h.reason === "FEES_ONLY" && (
                          <Button size="xs" variant="light" onClick={() => setReleasing(h)}>Release: fee booked by hand in QuickBooks</Button>
                        )}
                      </Table.Td>
                    )}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
        ))}
      </Stack>
      <Pager page={page} onChange={setPage} rows={holds.data} />
      <Modal opened={releasing !== null} onClose={() => setReleasing(null)} title="Release this fees-only row?">
        <Text size="sm" mb="md">
          Only release it once the fee is booked by hand in QuickBooks. The app keeps the fee amount and records who released it, but books nothing for it. The release can&apos;t be undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setReleasing(null)}>Cancel</Button>
          <Button color="red" onClick={() => {
            const hold = releasing;
            setReleasing(null);
            if (hold) void act(
              () => api(`/disbursement-holds/${encodeURIComponent(hold.disbursementId)}/release`, { method: "POST", body: JSON.stringify({ holdId: hold.id }) }),
              "Released", holds.reload,
            );
          }}>Release</Button>
        </Group>
      </Modal>
    </>
  );
}
