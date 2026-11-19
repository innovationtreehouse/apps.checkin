"use client";

import { Button } from "@mantine/core";
import { errorMessage } from "@checkin/component-ui";
import { useIsLocalInstance } from "@/components/EnvProvider";
import { api } from "@/lib/api";

type ErrorBody = { error?: string; detail?: string } | null;

/**
 * Local dev has no Shopify store, so this fires the mock orders/paid webhook in-app
 * (same endpoint the Debug → Shopify tool uses), settling the membership fee
 * end-to-end with zero setup. Renders nothing outside a local instance.
 */
export default function DevMockPaymentButton({ processId, saving, setSaving, onPaid, onFailed }: {
  processId: number;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  onPaid: () => Promise<void>;
  onFailed: (data: ErrorBody) => void;
}) {
  const isLocalInstance = useIsLocalInstance();
  if (!isLocalInstance) return null;

  const settle = async () => {
    setSaving(true);
    try {
      await api("/api/dev/shopify/orders-paid", { method: "POST", body: JSON.stringify({ processId }) });
      await onPaid();
    } catch (e) {
      onFailed({ error: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Button mt="md" disabled={saving} onClick={settle}>
      Pay now (local mock) →
    </Button>
  );
}
