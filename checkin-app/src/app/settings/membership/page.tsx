"use client";

import { centsToDecimalString } from "@checkin/money";
import { useState } from "react";
import { Alert, Badge, Button, Card, Center, Checkbox, Group, Loader, Modal, Radio, Stack, Text, TextInput, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { errorMessage, LoadError, showError, showSuccess } from "@checkin/component-ui";
import { useSeedForm } from "@/hooks/useSeedForm";
import { api, useLoad } from "@/lib/api";
import { useUnsavedGuard, shallowEqual } from "@/components/UnsavedChangesProvider";
import { useCheckinEnv, useDevMocks, useShopifyStoreDomain } from "@/components/EnvProvider";
import { notifyNavRefresh } from "@/lib/nav-refresh";
import { isRecheckPolicySet } from "@/lib/membership/bgRecheckPolicy";
import { useSession } from "next-auth/react";
import { LibraryReleaseCard } from "@/components/admin/LibraryReleaseCard";
import { membershipYearLabel, variantSlotYears } from "@/lib/programYear";
import { VariantPicker } from "./VariantPicker";

interface Settings {
  standardMembershipFeeCents: number;
  volunteerMembershipFeeCents: number;
  orgMembershipYearBoundary: string | null;
  orgMembershipVariantId: string | null;
  orgMembershipProductUrl: string | null;
  volunteerFamilyDiscountCode: string | null;
  bgRecheckMonths: number;
  devSigningTarget: string | null;
  scholarshipDenialGraceDays: number | null;
  releasedLibraries: string[];
}

interface YearVariant {
  membershipYear: number;
  shopifyVariantId: string;
  productUrl: string | null;
}

/** One membership year's slot on the form. */
interface YearSlot {
  year: number;
  variantId: string;
  productUrl: string;
}

// A task on the previous release returns the settings row directly.
type SettingsBody = { BoardSettings: Settings; MembershipYearVariant: YearVariant[] } | Settings;

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
  const [slots, setSlots] = useState<YearSlot[]>([]);
  const [savedSlots, setSavedSlots] = useState<YearSlot[]>([]);
  const [slotErrors, setSlotErrors] = useState<Record<number, string>>({});
  // Variant IDs are typed only where Shopify cannot be read; elsewhere they come from a product URL.
  const shopifyMock = useDevMocks().shopify;
  const storeDomain = useShopifyStoreDomain();
  const typedVariantIds = shopifyMock || !storeDomain;
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

  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ standardFee?: string; volunteerFee?: string; variantId?: string; scholarshipGraceDays?: string }>({});
  const isBoardMember = !!useSession().data?.user?.isBoardMember;

  const { data, error, reload } = useLoad<{ settings: SettingsBody }>("/api/settings/membership");
  const body = data?.settings;
  const releasedLibraries = (body && "BoardSettings" in body ? body.BoardSettings : body)?.releasedLibraries ?? [];

  const current = { standardFee, volunteerFee, bgRecheckMonths, scholarshipGraceDays, boundary, variantId, productUrl, discountCode, signingTarget, slots: JSON.stringify(slots) };

  // Confirm-checkbox gate only matters when a boundary already exists — changing
  // it shifts every household's cycle. First-time set has nothing to shift.
  const boundaryWasSet = !!initial?.boundary;

  const saveSettings = async () => {
    setFieldErrors({});
    const fe: { standardFee?: string; volunteerFee?: string; variantId?: string; scholarshipGraceDays?: string } = {};
    const nd = parseFloat(standardFee); if (standardFee.trim() === "" || isNaN(nd) || nd < 0) fe.standardFee = "Enter a dollar amount of 0 or more.";
    const vd = parseFloat(volunteerFee); if (volunteerFee.trim() === "" || isNaN(vd) || vd < 0) fe.volunteerFee = "Enter a dollar amount of 0 or more.";
    if (variantId.trim() !== "" && !/^\d+$/.test(variantId.trim())) fe.variantId = "Must be a numeric Shopify variant ID.";
    if (scholarshipGraceDays.trim() !== "") {
      const g = parseInt(scholarshipGraceDays.trim(), 10);
      if (!Number.isInteger(g) || g <= 0 || String(g) !== scholarshipGraceDays.trim()) fe.scholarshipGraceDays = "Enter a positive whole number of days, or leave blank to disable.";
    }
    const slotFe: Record<number, string> = {};
    slots.forEach((slot, i) => {
      const id = slot.variantId.trim();
      if (id === "" && savedSlots[i]?.variantId) slotFe[slot.year] = "A saved variant can be replaced, not cleared.";
      else if (id !== "" && !/^\d+$/.test(id)) slotFe[slot.year] = "Must be a numeric Shopify variant ID.";
    });
    setSlotErrors(slotFe);
    if (fe.standardFee || fe.volunteerFee || fe.variantId || fe.scholarshipGraceDays || Object.keys(slotFe).length) { setFieldErrors(fe); return; }
    const changedSlots = slots.filter((slot, i) =>
      slot.variantId.trim() !== "" &&
      (slot.variantId.trim() !== savedSlots[i]?.variantId || slot.productUrl.trim() !== savedSlots[i]?.productUrl));
    setSaving(true);
    try {
      await api("/api/settings/membership", {
        method: "PUT",
        body: JSON.stringify({
          perYearVariantClient: true,
          standardMembershipFeeCents: Math.round(parseFloat(standardFee || "0") * 100),
          volunteerMembershipFeeCents: Math.round(parseFloat(volunteerFee || "0") * 100),
          orgMembershipVariantId: variantId.trim() || null,
          orgMembershipProductUrl: productUrl.trim() || null,
          ...(changedSlots.length ? {
            membershipYearVariants: changedSlots.map((slot) => ({
              membershipYear: slot.year,
              shopifyVariantId: slot.variantId.trim(),
              productUrl: slot.productUrl.trim() || null,
            })),
          } : {}),
          volunteerFamilyDiscountCode: discountCode.trim() || null,
          bgRecheckMonths: Math.round(parseInt(bgRecheckMonths || "0", 10)),
          scholarshipDenialGraceDays: scholarshipGraceDays.trim() === "" ? null : parseInt(scholarshipGraceDays.trim(), 10),
          // Dev instances only — the API rejects it elsewhere.
          ...(isDev ? { devSigningTarget: signingTarget } : {}),
          // Send the boundary when the unlock is checked, or when it was never set (no
          // unlock shown then — nothing to protect from an accidental shift).
          ...(boundaryUnlocked || !boundaryWasSet ? { orgMembershipYearBoundary: boundary || null } : {}),
        }),
      });
      showSuccess("Settings saved.");
      setBoundaryUnlocked(false);
      notifyNavRefresh();
      setInitial(current);
      setSavedSlots(slots);
    } catch (e) { showError(errorMessage(e)); }
    finally { setSaving(false); }
  };

  const updateSlot = (year: number, change: Partial<YearSlot>) => {
    setSlots((current) => current.map((slot) => (slot.year === year ? { ...slot, ...change } : slot)));
    setSlotErrors((errors) => ({ ...errors, [year]: "" }));
  };

  const bulkOpenRenewals = async () => {
    closeConfirmOpenRenewals();
    setSaving(true);
    try {
      const data = await api<{ opened: number; skipped: number }>("/api/settings/membership/bulk-open-renewals", { method: "POST" });
      showSuccess(`Opened ${data.opened} renewal(s); ${data.skipped} already in progress.`);
    } catch (e) { showError(errorMessage(e)); }
    finally { setSaving(false); }
  };

  const isDirty = !!initial && !shallowEqual(initial, current);
  useUnsavedGuard(isDirty);
  useSeedForm(data, isDirty, ({ settings: answer }) => {
    const settings = "BoardSettings" in answer ? answer.BoardSettings : answer;
    const rows = "BoardSettings" in answer ? answer.MembershipYearVariant : [];
    const loadedSlots: YearSlot[] = settings.orgMembershipYearBoundary
      ? variantSlotYears(new Date(settings.orgMembershipYearBoundary), new Date()).map((year) => {
          const row = rows.find((r) => r.membershipYear === year);
          return { year, variantId: row?.shopifyVariantId ?? "", productUrl: row?.productUrl ?? "" };
        })
      : [];
    const snap = {
      standardFee: centsToDecimalString(settings.standardMembershipFeeCents),
      volunteerFee: centsToDecimalString(settings.volunteerMembershipFeeCents),
      bgRecheckMonths: String(settings.bgRecheckMonths ?? 0),
      scholarshipGraceDays: settings.scholarshipDenialGraceDays != null ? String(settings.scholarshipDenialGraceDays) : "",
      boundary: settings.orgMembershipYearBoundary ? settings.orgMembershipYearBoundary.slice(0, 10) : "",
      variantId: settings.orgMembershipVariantId ?? "",
      productUrl: settings.orgMembershipProductUrl ?? "",
      discountCode: settings.volunteerFamilyDiscountCode ?? "",
      signingTarget: settings.devSigningTarget ?? "zoho",
      slots: JSON.stringify(loadedSlots),
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
    setSlots(loadedSlots);
    setSavedSlots(loadedSlots);
    setInitial(snap);
  });

  return (
    <Stack>
      {error && <LoadError what="the membership settings" message={error} onRetry={reload} />}

      {!data ? (
        !error && <Center py="xl"><Loader /></Center>
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
                error={!isRecheckPolicySet(parseInt(bgRecheckMonths, 10)) ? "Required — not configured." : undefined}
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

            {!isRecheckPolicySet(parseInt(bgRecheckMonths, 10)) && (
              <Alert color="red" variant="light" mt="md">
                ⛔ Background-check interval is <strong>not set</strong>. Until the board enters the
                policy value (in months), every background check counts as expired: every renewal
                is sent back for a fresh background review, and no one counts as a supervising
                adult in the two-deep check. Enter the real Treehouse re-check interval above.
              </Alert>
            )}

            <Alert color="yellow" variant="light" mt="md">
              ⚠️ These amounts only set what applicants <strong>see</strong> in the membership
              process. What members are actually charged is the price of the Shopify product below
              (less the volunteer discount code, for volunteer households).
            </Alert>

            <Title order={4} mt="lg" mb="sm">Shopify checkout</Title>
            <Stack gap="md">
              <VariantPicker
                name="Membership product"
                urlLabel="Membership product URL"
                idLabel="Membership product variant ID"
                value={{ variantId, productUrl }}
                onChange={(next) => { setVariantId(next.variantId); setProductUrl(next.productUrl); setFieldErrors((f) => ({ ...f, variantId: undefined })); }}
                editableId={typedVariantIds}
                canClear
                error={fieldErrors.variantId ?? (variantId.trim() === "" ? "Required for checkout — not configured." : undefined)}
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
              {slots.map((slot, i) => {
                const label = membershipYearLabel(slot.year);
                return (
                  <Stack key={slot.year} gap="xs">
                    <Group gap="xs">
                      <Title order={5}>{label}</Title>
                      {i === 1 && slot.variantId.trim() === "" && <Badge color="red">needs variant</Badge>}
                    </Group>
                    <VariantPicker
                      name={label}
                      urlLabel={`${label} product URL`}
                      idLabel={`${label} variant ID`}
                      extractLabel={`Extract variant from URL for ${label}`}
                      value={slot}
                      onChange={(next) => updateSlot(slot.year, next)}
                      editableId={typedVariantIds}
                      canClear={!savedSlots[i]?.variantId}
                      error={slotErrors[slot.year]}
                    />
                  </Stack>
                );
              })}
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

            <Button mt="lg" disabled={saving} loading={saving} onClick={saveSettings} style={{ alignSelf: "flex-start" }}>
              Save settings
            </Button>
          </Card>

          {isBoardMember && <LibraryReleaseCard key={releasedLibraries.join()} initial={releasedLibraries} />}

          <Card withBorder radius="md" padding="lg" style={{ borderColor: "var(--mantine-color-yellow-5)" }}>
            <Title order={3} mb="xs">Go-live: open renewals</Title>
            <Text c="yellow.7" size="sm">
              ⚠️ One-time go-live action. Opens a renewal cycle for <strong>every active member</strong> so
              they renew for the upcoming year. Press this once, after your existing members are
              imported (board or isSysadmin).
            </Text>
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
