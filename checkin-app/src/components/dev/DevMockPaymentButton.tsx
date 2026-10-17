"use client";

import { Button } from "@mantine/core";
import { useIsLocalInstance } from "@/components/EnvProvider";

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
      const res = await fetch("/api/dev/shopify/orders-paid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processId }),
      });
      if (res.ok) await onPaid();
      else onFailed(await res.json().catch(() => null));
    } catch {
      onFailed(null);
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
