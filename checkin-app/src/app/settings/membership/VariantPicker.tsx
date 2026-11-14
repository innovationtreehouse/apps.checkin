"use client";

import { formatCents } from "@checkin/money";
import { useState } from "react";
import { Button, Group, Radio, Stack, Text, TextInput } from "@mantine/core";
import { errorMessage, showError, showSuccess } from "@checkin/component-ui";
import { api } from "@/lib/api";

export interface VariantChoice {
  variantId: string;
  productUrl: string;
}

interface ExtractedProduct {
  productTitle: string;
  variants: { id: string; title: string; priceCents: number | null }[];
}

interface Props {
  /** Names the group, e.g. "Membership product" or "2026-2027". */
  name: string;
  urlLabel: string;
  idLabel: string;
  extractLabel?: string;
  value: VariantChoice;
  onChange: (next: VariantChoice) => void;
  /** Typed variant ID instead of the read-only display: only where Shopify cannot be read (local mock or no store). */
  editableId: boolean;
  canClear: boolean;
  error?: string;
}

/**
 * Picks a membership product variant by its storefront URL: the server reads
 * the product from Shopify, a single variant is chosen at once, several are
 * offered as a list. The choice shows read-only with its product title,
 * variant title and price; changing it means extracting another URL.
 */
export function VariantPicker({ name, urlLabel, idLabel, extractLabel, value, onChange, editableId, canClear, error }: Props) {
  const [urlInput, setUrlInput] = useState(value.productUrl);
  // A new URL from outside (settings loaded, saved, or cleared) replaces whatever was typed.
  const [shownUrl, setShownUrl] = useState(value.productUrl);
  if (value.productUrl !== shownUrl) {
    setShownUrl(value.productUrl);
    setUrlInput(value.productUrl);
  }
  const [extracted, setExtracted] = useState<{ url: string; product: ExtractedProduct } | null>(null);
  const [extracting, setExtracting] = useState(false);

  const choose = (variantId: string, url: string) => {
    onChange({ variantId, productUrl: url });
    showSuccess(`Variant ${variantId} chosen — press Save settings to keep it.`);
  };

  const extract = async () => {
    const url = urlInput.trim();
    setExtracting(true);
    try {
      const product = await api<ExtractedProduct>("/api/settings/membership/extract-variant", {
        method: "POST",
        body: JSON.stringify({ productUrl: url }),
        invalidate: false,
      });
      setExtracted({ url, product });
      if (product.variants.length === 1) choose(product.variants[0].id, url);
    } catch (e) { showError(errorMessage(e)); }
    finally { setExtracting(false); }
  };

  const price = (cents: number | null) => (cents != null ? formatCents(cents) : "price unknown");
  const options = extracted && extracted.product.variants.length > 1 ? extracted.product.variants : null;
  const chosen = extracted?.product.variants.find((v) => v.id === value.variantId);

  return (
    <Stack gap="xs" role="group" aria-label={name}>
      <Group align="flex-end" gap="sm" wrap="wrap">
        <TextInput
          label={urlLabel}
          placeholder="https://your-store.myshopify.com/products/membership"
          w={420}
          value={urlInput}
          onChange={(e) => {
            setUrlInput(e.currentTarget.value);
            // With a typed ID there is no extraction to attach the URL, so it is kept as typed.
            if (editableId) onChange({ variantId: value.variantId, productUrl: e.currentTarget.value });
          }}
        />
        <Button variant="light" aria-label={extractLabel} loading={extracting} disabled={extracting || !urlInput.trim()} onClick={extract}>
          Extract variant from URL
        </Button>
      </Group>

      {options && (
        <Radio.Group
          label={`Pick the variant of ${extracted!.product.productTitle}`}
          value={chosen ? chosen.id : null}
          onChange={(id) => choose(id, extracted!.url)}
        >
          <Stack gap={4} mt={4}>
            {options.map((v) => (
              <Radio key={v.id} value={v.id} label={`${v.title} — ${price(v.priceCents)} (variant ${v.id})`} />
            ))}
          </Stack>
        </Radio.Group>
      )}

      {editableId ? (
        <TextInput
          label={idLabel}
          description="Shopify can't be read on this instance, so the variant ID is typed here."
          placeholder="1234567890"
          w={260}
          error={error}
          value={value.variantId}
          onChange={(e) => onChange({ variantId: e.currentTarget.value, productUrl: value.productUrl })}
        />
      ) : (
        <Stack gap={2}>
          <Text size="sm" fw={500}>{idLabel}</Text>
          {chosen ? (
            <Text size="sm">{extracted!.product.productTitle} — {chosen.title} — {price(chosen.priceCents)} (variant {chosen.id})</Text>
          ) : value.variantId ? (
            <Text size="sm">Variant {value.variantId}{value.productUrl ? ` from ${value.productUrl}` : ""}</Text>
          ) : (
            <Text size="sm" c="dimmed">No variant chosen.</Text>
          )}
          {error && <Text size="sm" c="red">{error}</Text>}
        </Stack>
      )}

      {canClear && value.variantId && (
        <Button variant="subtle" size="xs" style={{ alignSelf: "flex-start" }} onClick={() => { onChange({ variantId: "", productUrl: "" }); setExtracted(null); }}>
          Clear {idLabel}
        </Button>
      )}
    </Stack>
  );
}
