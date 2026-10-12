"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Code,
  CopyButton,
  Group,
  List,
  Loader,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { SettingsTabs } from "@/components/admin/SettingsTabs";
import { useRequireRole } from "@/hooks/useRequireRole";
import type { ShopifyWebhookReceipt } from "@/lib/shopifyWebhookReceipt";

type Receipt = ShopifyWebhookReceipt & { id: number };

interface Status {
  webhookUrl: string;
  storeDomain: string | null;
  receipts: Receipt[];
}

/**
 * Shopify Webhook settings tab — verifies the store's webhook wiring
 * end-to-end from the RECEIVING side. Shopify's Admin API cannot trigger its
 * "Send test notification" button, and an app token cannot even list webhooks
 * created in the store admin (they belong to the admin pseudo-app), so the
 * only reliable check is: press the button in Shopify, then confirm the
 * delivery — and its signature verdict — arrived here. The inbound webhook
 * route records every delivery (valid or not) as a receipt; this page shows
 * the latest ones.
 */
export default function ShopifyWebhookSettingsPage() {
  // Same gate as the sibling settings pages: board + sysadmin, redirected client-side
  // before any content renders. The status route re-enforces the same roles.
  const { ready, loading: authLoading } = useRequireRole(["isSysadmin", "isBoardMember"]);

  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => fetch("/api/settings/shopify-webhook")
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus((await res.json()) as Status);
    })
    .catch(() => {
      setFailed(true);
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  if (authLoading) return <Center mih="60vh"><Loader /></Center>;
  if (!ready) return null; // redirect to / is in flight

  const badSignature = status?.receipts.some((r) => !r.hmacValid) ?? false;

  return (
    <Stack>
      <SettingsTabs active="shopify-webhook" />

      {loading && !status ? (
        <Center py="xl"><Loader /></Center>
      ) : failed && !status ? (
        <Text c="red">Failed to load webhook status.</Text>
      ) : status ? (
        <>
          <Card withBorder radius="md" padding="lg">
            <Title order={3} mb="xs">Webhook endpoint</Title>
            <Text size="sm" c="dimmed" mb="md">
              Membership and program payments settle <strong>only</strong> when Shopify delivers an{" "}
              <Code>orders/paid</Code> webhook to this endpoint. If the store has no webhook registered — or it
              signs with the wrong secret — the application silently never learns that members paid.
            </Text>
            <Group gap="sm">
              <Code style={{ fontSize: "var(--mantine-font-size-sm)" }}>{status.webhookUrl}</Code>
              <CopyButton value={status.webhookUrl}>
                {({ copied, copy }) => (
                  <Button size="xs" variant="light" color={copied ? "teal" : undefined} onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </Card>

          <Card withBorder radius="md" padding="lg">
            <Title order={3} mb="xs">How to verify the wiring</Title>
            <List type="ordered" size="sm" spacing="xs">
              <List.Item>
                In Shopify, open{" "}
                {status.storeDomain ? (
                  <Anchor href={`https://${status.storeDomain}/admin/settings/notifications`} target="_blank" rel="noreferrer">
                    the store&apos;s notification settings
                  </Anchor>
                ) : (
                  <>the store&apos;s notification settings (the Shopify store domain is not configured for this environment)</>
                )}{" "}
                and create or verify an <Code>orders/paid</Code> webhook pointing at the URL above.
              </List.Item>
              <List.Item>Press <strong>Send test notification</strong> next to that webhook.</List.Item>
              <List.Item>Press <strong>Refresh</strong> below — the test delivery should appear within a few seconds.</List.Item>
            </List>
          </Card>

          <Card withBorder radius="md" padding="lg">
            <Group justify="space-between" mb="xs">
              <Title order={3}>Recent deliveries</Title>
              <Button size="xs" variant="light" onClick={() => { setLoading(true); setFailed(false); load(); }} loading={loading}>
                Refresh
              </Button>
            </Group>
            <Text size="sm" c="dimmed" mb="md">
              Every delivery this environment received on the endpoint above, newest first — including
              deliveries whose signature failed verification.
            </Text>

            {badSignature && (
              <Alert color="red" variant="light" mb="md">
                A delivery with signature ✗ reached this endpoint but failed verification: the secret the
                store signs webhooks with and the webhook secret configured for this environment are not the
                matching pair. Fix the configuration — until then, payments will not settle.
              </Alert>
            )}

            {status.receipts.length === 0 ? (
              <Alert color="yellow" variant="light">
                No deliveries recorded. If you pressed <strong>Send test notification</strong> and still see
                nothing after refreshing, Shopify cannot reach the endpoint above — the webhook is not
                registered, or it points at the wrong URL.
              </Alert>
            ) : (
              <Table.ScrollContainer minWidth={700}>
                <Table striped highlightOnHover verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Time</Table.Th>
                      <Table.Th>Topic</Table.Th>
                      <Table.Th>Test</Table.Th>
                      <Table.Th>Signature</Table.Th>
                      <Table.Th>Order</Table.Th>
                      <Table.Th>Outcome</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {status.receipts.map((r) => (
                      <Table.Tr key={r.id}>
                        <Table.Td style={{ whiteSpace: "nowrap" }}>{new Date(r.receivedAt).toLocaleString()}</Table.Td>
                        <Table.Td>{r.topic ? <Code>{r.topic}</Code> : <Text c="dimmed">—</Text>}</Table.Td>
                        <Table.Td>{r.test ? <Badge color="gray" variant="light">test</Badge> : <Text c="dimmed">—</Text>}</Table.Td>
                        <Table.Td>
                          {r.hmacValid ? <Text c="green" component="span">✓</Text> : <Text c="red" component="span" fw={700}>✗</Text>}
                        </Table.Td>
                        <Table.Td>{r.orderId ?? <Text c="dimmed">—</Text>}</Table.Td>
                        <Table.Td>{r.outcome}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Card>
        </>
      ) : null}
    </Stack>
  );
}
