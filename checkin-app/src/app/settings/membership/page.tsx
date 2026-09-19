"use client";

import { useState, useEffect, useCallback } from "react";
import { Alert, Button, Card, Center, Checkbox, Group, Loader, Modal, Radio, Stack, Text, TextInput, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { SettingsTabs } from "@/components/admin/SettingsTabs";
import { useUnsavedGuard, shallowEqual } from "@/components/UnsavedChangesProvider";
import { useCheckinEnv } from "@/components/EnvProvider";
import { notifyNavRefresh } from "@/lib/nav-refresh";

interface Settings {
  standardMembershipFeeCents: number;
  volunteerMembershipFeeCents: number;
  orgMembershipYearBoundary: string | null;
  orgMembershipVariantId: string | null;
  orgMembershipProductUrl: string | null;
  volunteerDiscountCode: string | null;
  bgRecheckMonths: number;
  devSigningTarget: string | null;
  scholarshipDenialGraceDays: number | null;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

// Next occurrence (>= now) of the stored boundary's month/day, as a label.
// ponytail: mirrors nextBoundary() in lib/membership/renewal.ts — can't import, it pulls in prisma.
const currentBoundaryLabel = (iso: string) => {
  const [, m, d] = iso.split("-").map(Number);
  if (!m || !d) return null;
  const now = new Date();
  let b = Date.UTC(now.getUTCFullYear(), m - 1, d);
  if (b < now.getTime()) b = Date.UTC(now.getUTCFullYear() + 1, m - 1, d);
  return new Date(b).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
};

export default function MembershipSettingsPage() {
  const [standardFee, setStandardFee] = useState("0");
  const [volunteerFee, setVolunteerFee] = useState("0");
  const [bgRecheckMonths, setBgRecheckMonths] = useState("0");
  const [scholarshipGraceDays, setScholarshipGraceDays] = useState("");
  const [boundary, setBoundary] = useState("");
  const [boundaryUnlocked, setBoundaryUnlocked] = useState(false);
  const [variantId, setVariantId] = useState("");
  const [productUrl, setProductUrl] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [discountCode, setDiscountCode] = useState("");
  // Dev-instance-only: where contract signing requests go ('zoho' | 'debug').
  // Strictly CHECKIN_ENV=dev, not useIsDevInstance()'s not-prod: the API only
  // honours devSigningTarget on a dev instance, so only send it there.
  const isDev = useCheckinEnv() === "dev";
  const [signingTarget, setSigningTarget] = useState("zoho");

  // Snapshot of the fee-form values as last loaded/saved; isDirty compares it to
  // current state to drive the unsaved-changes guard.
  // ponytail: guards the main Save-button form only. The go-live card below is a
  // separate save flow — wire it if it grows edits.
  const [initial, setInitial] = useState<Record<string, string> | null>(null);

  const [confirmOpenRenewalsOpened, { open: openConfirmOpenRenewals, close: closeConfirmOpenRenewals }] = useDisclosure(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ standardFee?: string; volunteerFee?: string; variantId?: string; scholarshipGraceDays?: string }>({});
  const [saveNotice, setSaveNotice] = useState<{ text: string; err: boolean } | null>(null);
  const [renewalNotice, setRenewalNotice] = useState<{ text: string; err: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sRes = await fetch("/api/settings/membership");
      if (sRes.ok) {
        const { settings } = (await sRes.json()) as { settings: Settings };
        const snap = {
          standardFee: dollars(settings.standardMembershipFeeCents),
          volunteerFee: dollars(settings.volunteerMembershipFeeCents),
          bgRecheckMonths: String(settings.bgRecheckMonths ?? 0),
          scholarshipGraceDays: settings.scholarshipDenialGraceDays != null ? String(settings.scholarshipDenialGraceDays) : "",
          boundary: settings.orgMembershipYearBoundary ? settings.orgMembershipYearBoundary.slice(0, 10) : "",
          variantId: settings.orgMembershipVariantId ?? "",
          productUrl: settings.orgMembershipProductUrl ?? "",
          discountCode: settings.volunteerDiscountCode ?? "",
          signingTarget: settings.devSigningTarget ?? "zoho",
        };
        setStandardFee(snap.standardFee);
        setVolunteerFee(snap.volunteerFee);
        setBgRecheckMonths(snap.bgRecheckMonths);
        setScholarshipGraceDays(snap.scholarshipGraceDays);
        setBoundary(snap.boundary);
        setVariantId(snap.variantId);
        setProductUrl(snap.productUrl);
        setDiscountCode(snap.discountCode);
        setSigningTarget(snap.signingTarget);
        setInitial(snap);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Confirm-checkbox gate only matters when a boundary already exists — changing
  // it shifts every household's cycle. First-time set has nothing to shift.
  const boundaryWasSet = !!initial?.boundary;

  const saveSettings = async () => {
    setSaveNotice(null);
    setFieldErrors({});
    const fe: { standardFee?: string; volunteerFee?: string; variantId?: string; scholarshipGraceDays?: string } = {};
    const nd = parseFloat(standardFee); if (standardFee.trim() === "" || isNaN(nd) || nd < 0) fe.standardFee = "Enter a dollar amount of 0 or more.";
    const vd = parseFloat(volunteerFee); if (volunteerFee.trim() === "" || isNaN(vd) || vd < 0) fe.volunteerFee = "Enter a dollar amount of 0 or more.";
    if (variantId.trim() !== "" && !/^\d+$/.test(variantId.trim())) fe.variantId = "Must be a numeric Shopify variant ID.";
    if (scholarshipGraceDays.trim() !== "") {
      const g = parseInt(scholarshipGraceDays.trim(), 10);
      if (!Number.isInteger(g) || g <= 0 || String(g) !== scholarshipGraceDays.trim()) fe.scholarshipGraceDays = "Enter a positive whole number of days, or leave blank to disable.";
    }
    if (fe.standardFee || fe.volunteerFee || fe.variantId || fe.scholarshipGraceDays) { setFieldErrors(fe); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/settings/membership", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          standardMembershipFeeCents: Math.round(parseFloat(standardFee || "0") * 100),
          volunteerMembershipFeeCents: Math.round(parseFloat(volunteerFee || "0") * 100),
          orgMembershipVariantId: variantId.trim() || null,
          orgMembershipProductUrl: productUrl.trim() || null,
          volunteerDiscountCode: discountCode.trim() || null,
          bgRecheckMonths: Math.round(parseInt(bgRecheckMonths || "0", 10)),
          scholarshipDenialGraceDays: scholarshipGraceDays.trim() === "" ? null : parseInt(scholarshipGraceDays.trim(), 10),
          // Dev instances only — the API rejects it elsewhere.
          ...(isDev ? { devSigningTarget: signingTarget } : {}),
          // Send the boundary when the unlock is checked, or when it was never set (no
          // unlock shown then — nothing to protect from an accidental shift).
          ...(boundaryUnlocked || !boundaryWasSet ? { orgMembershipYearBoundary: boundary || null } : {}),
        }),
      });
      if (res.ok) { notifications.show({ message: "Settings saved." }); setBoundaryUnlocked(false); notifyNavRefresh(); await load(); }
      else { const d = await res.json().catch(() => ({})); setSaveNotice({ text: d.error || "Save failed.", err: true }); }
    } catch { notifications.show({ color: "red", message: "Network error.", autoClose: false }); }
    finally { setSaving(false); }
  };

  // Ask the server to pull the variant ID out of the pasted product URL (the
  // Shopify admin UI hides the lone variant of a single-variant product, so
  // there is nowhere to copy it from). Fills the variant-ID field only —
  // nothing is persisted until the admin presses Save settings.
  const extractVariant = async () => {
    setSaveNotice(null);
    setExtracting(true);
    try {
      const res = await fetch("/api/settings/membership/extract-variant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productUrl: productUrl.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setVariantId(data.variantId);
        setFieldErrors((f) => ({ ...f, variantId: undefined }));
        notifications.show({ message: `Variant ${data.variantId} filled in — press Save settings to keep it.` });
      } else {
        setSaveNotice({ text: data.error || "Could not extract the variant.", err: true });
      }
    } catch { notifications.show({ color: "red", message: "Network error.", autoClose: false }); }
    finally { setExtracting(false); }
  };

  const bulkOpenRenewals = async () => {
    closeConfirmOpenRenewals();
    setSaving(true);
    setRenewalNotice(null);
    try {
      const res = await fetch("/api/settings/membership/bulk-open-renewals", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setRenewalNotice({ text: `Opened ${data.opened} renewal(s); ${data.skipped} already in progress.`, err: false });
      else setRenewalNotice({ text: data.error || "Failed.", err: true });
    } catch { notifications.show({ color: "red", message: "Network error.", autoClose: false }); }
    finally { setSaving(false); }
  };

  const isDirty =
    !!initial &&
    !shallowEqual(initial, { standardFee, volunteerFee, bgRecheckMonths, scholarshipGraceDays, boundary, variantId, productUrl, discountCode, signingTarget });
  useUnsavedGuard(isDirty);

  return (
    <Stack>
      <SettingsTabs active="membership" />

      {loading ? (
        <Center py="xl"><Loader /></Center>
      ) : (
        <>
          <Card withBorder radius="md" padding="lg">
            <Title order={3} mb="md">Membership fees &amp; configuration</Title>
            <Group align="flex-end" gap="lg" wrap="wrap">
              <TextInput
                label="Standard annual membership fee"
                leftSection="$"
                inputMode="decimal"
                w={160}
                error={fieldErrors.standardFee}
                value={standardFee}
                onChange={(e) => { setStandardFee(e.currentTarget.value); setFieldErrors((f) => ({ ...f, standardFee: undefined })); }}
              />
              <TextInput
                label="Volunteer annual membership fee"
                leftSection="$"
                inputMode="decimal"
                w={160}
                error={fieldErrors.volunteerFee}
                value={volunteerFee}
                onChange={(e) => { setVolunteerFee(e.currentTarget.value); setFieldErrors((f) => ({ ...f, volunteerFee: undefined })); }}
              />
              <TextInput
                label="Background check valid for"
                description="Months. Set to Treehouse policy."
                rightSection={<Text size="sm" c="dimmed">mo</Text>}
                rightSectionWidth={36}
                inputMode="numeric"
                w={200}
                error={(!bgRecheckMonths || parseInt(bgRecheckMonths, 10) <= 0) ? "Required — not configured." : undefined}
                value={bgRecheckMonths}
                onChange={(e) => setBgRecheckMonths(e.currentTarget.value)}
              />
              <TextInput
                label="Scholarship denial grace period"
                description="Days a denied scholarship applicant keeps their held seat before auto-release. Blank disables auto-release."
                rightSection={<Text size="sm" c="dimmed">days</Text>}
                rightSectionWidth={44}
                inputMode="numeric"
                w={220}
                error={fieldErrors.scholarshipGraceDays}
                value={scholarshipGraceDays}
                onChange={(e) => { setScholarshipGraceDays(e.currentTarget.value); setFieldErrors((f) => ({ ...f, scholarshipGraceDays: undefined })); }}
              />
            </Group>

            {(!bgRecheckMonths || parseInt(bgRecheckMonths, 10) <= 0) && (
              <Alert color="red" variant="light" mt="md">
                ⛔ Background-check interval is <strong>not set</strong>. Until the board enters the
                policy value (in months), every renewal will be sent back for a fresh background
                review. Enter the real Treehouse re-check interval above.
              </Alert>
            )}

            <Alert color="yellow" variant="light" mt="md">
              ⚠️ These amounts only set what applicants <strong>see</strong> in the membership
              process. What members are actually charged is the price of the Shopify product below
              (less the volunteer discount code, for volunteer households).
            </Alert>

            <Title order={4} mt="lg" mb="sm">Shopify checkout</Title>
            <Stack gap="md">
              <Group align="flex-end" gap="sm" wrap="wrap">
                <TextInput
                  label="Membership product URL"
                  description="Paste the product's storefront page URL; “Extract variant from URL” fills the variant ID below from it."
                  placeholder="https://your-store.myshopify.com/products/membership"
                  w={420}
                  value={productUrl}
                  onChange={(e) => setProductUrl(e.currentTarget.value)}
                />
                <Button variant="light" loading={extracting} disabled={extracting || !productUrl.trim()} onClick={extractVariant}>
                  Extract variant from URL
                </Button>
              </Group>
              <TextInput
                label="Membership product variant ID"
                description="The Shopify variant ID of the membership product. We build the “Pay with Shopify” link from it as https://<store>/cart/<variantId>:1."
                placeholder="1234567890"
                w={260}
                error={fieldErrors.variantId ?? (variantId.trim() === "" ? "Required for checkout — not configured." : undefined)}
                value={variantId}
                onChange={(e) => { setVariantId(e.currentTarget.value); setFieldErrors((f) => ({ ...f, variantId: undefined })); }}
              />
              <TextInput
                label="Volunteer discount code"
                description="Create this discount in Shopify, then paste the code here. It is appended to the checkout link for volunteer households only."
                placeholder="VOLUNTEER"
                w={260}
                error={discountCode.trim() === "" ? "Required for checkout — not configured." : undefined}
                value={discountCode}
                onChange={(e) => setDiscountCode(e.currentTarget.value)}
              />
            </Stack>

            <Alert color={boundary ? "yellow" : "red"} variant="light" mt="md" title="Membership-year boundary">
              {boundary ? (
                <Text size="sm" mb="sm">
                  ⚠️ Changing this date shifts the renewal cycle for <strong>every household</strong>.
                  Only change it if you are sure.
                </Text>
              ) : (
                <Text size="sm" mb="sm">
                  ⛔ The membership-year boundary is <strong>not configured</strong>. Renewal cycles
                  have no anchor date until you enter it below.
                </Text>
              )}
              <Text size="sm" mb="sm">
                Current boundary:{" "}
                <strong>{initial?.boundary ? (currentBoundaryLabel(initial.boundary) ?? "—") : "not set"}</strong>
              </Text>
              {boundaryWasSet && (
                <Checkbox
                  mb="sm"
                  checked={boundaryUnlocked}
                  onChange={(e) => setBoundaryUnlocked(e.currentTarget.checked)}
                  label="I understand — let me edit the boundary date"
                />
              )}
              <TextInput
                type="date"
                w={220}
                value={boundary}
                onChange={(e) => setBoundary(e.currentTarget.value)}
                disabled={boundaryWasSet && !boundaryUnlocked}
              />
            </Alert>

            {isDev && (
              <Alert color="grape" variant="light" mt="md" title="Contract signing target (dev instance only)">
                <Text size="sm" mb="sm">
                  🧪 Where membership contract signing requests go on <strong>this dev instance</strong>.
                  Prod always uses Zoho; this switch never exists there.
                </Text>
                <Radio.Group value={signingTarget} onChange={setSigningTarget}>
                  <Stack gap="xs">
                    <Radio
                      value="zoho"
                      label="Real Zoho Sign"
                      description="Requests go to Zoho (requires Zoho credentials on this instance; dev requests are watermarked NOT BINDING)."
                    />
                    <Radio
                      value="debug"
                      label="Debug signing"
                      description="Requests go to the in-app /dev/zoho-sign interstitial — no Zoho account or credentials involved."
                    />
                  </Stack>
                </Radio.Group>
              </Alert>
            )}

            {saveNotice && (
              <Alert mt="lg" color={saveNotice.err ? "red" : "treehouseGreen"} variant="light">
                {saveNotice.text}
              </Alert>
            )}

            <Button mt="lg" disabled={saving} loading={saving} onClick={saveSettings} style={{ alignSelf: "flex-start" }}>
              Save settings
            </Button>
          </Card>

          <Card withBorder radius="md" padding="lg" style={{ borderColor: "var(--mantine-color-yellow-5)" }}>
            <Title order={3} mb="xs">Go-live: open renewals</Title>
            <Text c="yellow.7" size="sm">
              ⚠️ One-time go-live action. Opens a renewal cycle for <strong>every active member</strong> so
              they renew for the upcoming year. Press this once, after your existing members are
              imported (board or isSysadmin).
            </Text>
            {renewalNotice && (
              <Alert mt="md" mb="md" color={renewalNotice.err ? "red" : "treehouseGreen"} variant="light">
                {renewalNotice.text}
              </Alert>
            )}
            <Button color="yellow" disabled={saving} loading={saving} onClick={openConfirmOpenRenewals}>
              Open renewals for all active members
            </Button>
          </Card>
        </>
      )}

      <Modal
        opened={confirmOpenRenewalsOpened}
        onClose={closeConfirmOpenRenewals}
        title={<Text span fw={700} fz="lg">Open Renewals For All Active Members</Text>}
        centered
      >
        <Text mb="lg">
          Open a renewal cycle for ALL active members now? This is a one-time go-live action.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeConfirmOpenRenewals}>Cancel</Button>
          <Button color="yellow" onClick={bulkOpenRenewals}>Open Renewals</Button>
        </Group>
      </Modal>
    </Stack>
  );
}
