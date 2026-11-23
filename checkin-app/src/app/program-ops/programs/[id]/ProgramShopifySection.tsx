"use client";

import { useState } from 'react';
import { Alert, Button, Card, Group, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { errorMessage, showError, showSuccess, showWarning } from '@checkin/component-ui';
import { shallowEqual } from '@/components/UnsavedChangesProvider';
import { useSeedForm } from '@/hooks/useSeedForm';
import { api } from '@/lib/api';
import { isProgramCheckoutBroken } from '@/lib/programCheckout';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import type { ProgramDetail } from './page';

export function ProgramShopifySection({ programId, program, storeClosed, isSysAdminOrBoard, reload }: {
  programId: string;
  program: ProgramDetail;
  storeClosed: boolean;
  isSysAdminOrBoard: boolean;
  reload: () => Promise<void>;
}) {
  // Shopify identifiers, editable by sysadmin/board only (manual repair when
  // there's no live Shopify to sync against).
  const [shopifyProductIdInput, setShopifyProductIdInput] = useState("");
  const [variantInput, setVariantInput] = useState("");
  const [syncing, setSyncing] = useState(false);

  // The form reseeds from a read only while it is unedited, so a late read never overwrites typing.
  const shopifyForm = { shopifyProductIdInput, variantInput };
  const [seededShopify, setSeededShopify] = useState<typeof shopifyForm | null>(null);

  useSeedForm(program, !!seededShopify && !shallowEqual(seededShopify, shopifyForm), (data) => {
    const form = { shopifyProductIdInput: data.shopifyProductId ?? "", variantInput: data.shopifyVariantId ?? "" };
    setShopifyProductIdInput(form.shopifyProductIdInput);
    setVariantInput(form.variantInput);
    setSeededShopify(form);
  });

  const handleSaveShopifyIds = async () => {
    setSyncing(true);
    try {
      await api(`/api/programs/${programId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          shopifyProductId: shopifyProductIdInput || null,
          shopifyVariantId: variantInput || null,
        }),
      });
      showSuccess("Shopify identifiers saved.");
      notifyNavRefresh();
      setSeededShopify(shopifyForm);
      await reload();
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  };

  const handleSyncShopify = async () => {
    setSyncing(true);
    try {
      const data = await api<{ warning?: string }>(`/api/programs/${programId}/sync-shopify`, { method: 'POST' });
      if (data?.warning) showWarning(data.warning);
      else showSuccess("Shopify checkout configured.");
      notifyNavRefresh();
      await reload();
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      {isProgramCheckoutBroken(program, storeClosed) ? (
        <Alert color="red" variant="light" title="⚠️ Broken checkout">
          <Stack gap="xs" align="flex-start">
            <Text size="sm">
              This program has a price but no Shopify checkout variant — paid enrollment will not work
              (parents can&apos;t pay and enrollments stay pending). This happens when a program is priced
              after it was first created.
            </Text>
            {isSysAdminOrBoard && (
              <Button color="red" variant="filled" size="xs" loading={syncing} onClick={handleSyncShopify}>
                Sync to Shopify
              </Button>
            )}
          </Stack>
        </Alert>
      ) : program.shopifyProductId && (
        <Alert variant="light">✓ Pre-configured for Shopify Checkout (Product ID: {program.shopifyProductId})</Alert>
      )}

      {isSysAdminOrBoard && (
        <Card withBorder radius="md" padding="md">
          <Text fw={500} mb={4}>Shopify Checkout Identifiers</Text>
          <Text size="xs" c="dimmed" mb="sm">
            Admin/Board only. A priced program needs its variant ID or paid enrollment can&apos;t check out.
            One variant covers both tiers — member pricing is a discount code applied at checkout.
            Set these manually here (e.g. local/testing where there is no live Shopify), or use “Sync to Shopify” above to create them.
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="Variant ID" value={variantInput} onChange={e => setVariantInput(e.currentTarget.value)} placeholder="e.g. 40123456789" />
            <TextInput label="Product ID (optional)" value={shopifyProductIdInput} onChange={e => setShopifyProductIdInput(e.currentTarget.value)} placeholder="e.g. 80123456789" />
          </SimpleGrid>
          <Group mt="sm">
            <Button type="button" variant="light" size="xs" loading={syncing} onClick={handleSaveShopifyIds}>
              Save Shopify IDs
            </Button>
          </Group>
          <Text size="sm" mt="md">
            Reserved-seat variant: {program.claimantShopifyVariantId ?? "none — checkout uses the public variant"}
          </Text>
          <Text size="xs" c="dimmed">
            A hidden (unlisted, untracked) product the app&apos;s checkout links to, so a family holding a seat can pay even when the store shows the program sold out.
          </Text>
          {!program.claimantShopifyVariantId && !isProgramCheckoutBroken(program, storeClosed)
            && ((program.nonOrgMemberPriceCents ?? program.orgMemberPriceCents ?? 0) > 0) && (
            <Group mt="xs">
              <Button type="button" variant="light" size="xs" loading={syncing} onClick={handleSyncShopify}>
                Create reserved-seat product
              </Button>
            </Group>
          )}
        </Card>
      )}
    </>
  );
}
