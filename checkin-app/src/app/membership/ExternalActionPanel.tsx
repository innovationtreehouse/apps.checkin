"use client";

import { Anchor, Box, Button, Card, Checkbox, Group, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { APP_TIMEZONE, formatDate } from "@/lib/time";
import type { BgConsentControls, ExternalStatus } from "./useMembershipPage";

function ExternalTask({ done, title, doneText, doneExtra, children }: { done: boolean; title: string; doneText: string; doneExtra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card withBorder radius="md" padding="md" bg={done ? "var(--mantine-color-green-light)" : undefined}>
      <Group align="flex-start" wrap="nowrap">
        <ThemeIcon color={done ? "treehouseGreen" : "gray"} radius="xl" size="md" variant={done ? "filled" : "light"}>
          {done ? "✓" : "•"}
        </ThemeIcon>
        <Box style={{ flex: 1 }}>
          <Text fw={600} mb="xs">{title}</Text>
          {done ? (
            <>
              <Text c="green">{doneText}</Text>
              {doneExtra}
            </>
          ) : children}
        </Box>
      </Group>
    </Card>
  );
}

/** The PENDING_EXTERNAL_ACTION step: sign the agreement and consent to the background check. */
export default function ExternalActionPanel({ external, isRenewal, saving, onSign, onRefresh, bg }: {
  external: ExternalStatus | null;
  isRenewal: boolean;
  saving: boolean;
  onSign: () => void;
  onRefresh: () => void;
  bg: BgConsentControls;
}) {
  return (
    <Card withBorder radius="md" padding="lg">
      <Stack gap="md">
        <div>
          <Title order={2}>Sign &amp; start your background check</Title>
          <Text c="dimmed">
            {isRenewal
              ? "Renewing means signing a fresh membership agreement for the year, and a new background check if your previous one has expired. Once both are underway, we'll move you straight to payment — your membership stays active in the meantime."
              : "Once your agreement is signed and your background check is underway, we'll move you straight to payment — you won't have to wait for the background check to come back."}
          </Text>
        </div>

        <ExternalTask
          done={!!external?.contractSigned}
          title="Sign your membership agreement"
          doneText={external?.contractSignedAt
            ? `${external.signerName ? `Signed by ${external.signerName}` : "Signed"}, ${formatDate(external.contractSignedAt, { year: "numeric", month: "short", day: "numeric", timeZone: APP_TIMEZONE })}.`
            : "Agreement signed — thank you!"}
        >
          <Stack gap="xs" align="flex-start">
            <Text c="dimmed">
              Sign your personalized membership agreement online. This page updates
              automatically once it&apos;s signed. Have your insurance details handy — the
              agreement asks for your provider and policy number.
            </Text>
            <Button disabled={saving} loading={saving} onClick={onSign}>
              {external?.contractStarted ? "Resume signing →" : "Sign your membership agreement →"}
            </Button>
          </Stack>
        </ExternalTask>

        {external?.bgCleared ? (
          <ExternalTask done title="Background check" doneText="Your household&apos;s background check is still valid — no new check needed.">
            <Text c="dimmed" />
          </ExternalTask>
        ) : (
          <ExternalTask
            done={!!external?.bgConsented}
            title="Start your background check"
            doneText="Background check started — we&apos;ll finish it in the background."
            doneExtra={external?.deepLinkUrl ? (
              <Text size="sm" c="dimmed" mt="xs">
                Checked it by mistake, or still need to finish the form?{" "}
                <Anchor href={external.deepLinkUrl} target="_blank" rel="noopener noreferrer">
                  Reopen the Averity consent form →
                </Anchor>
              </Text>
            ) : undefined}
          >
            <Stack gap="xs" align="flex-start">
              <Text c="dimmed">
                Consent to your background check on Averity. It runs in the background — you
                can keep going and pay while it completes.
              </Text>
              {external?.deepLinkUrl ? (
                <>
                  <Button
                    component="a"
                    href={external.deepLinkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={bg.markLinkOpened}
                  >
                    Consent on Averity →
                  </Button>
                  <Checkbox
                    label="I submitted my consent on Averity"
                    description={bg.linkOpened ? undefined : "Open the Averity form above first, then confirm here."}
                    checked={bg.consenting}
                    disabled={!bg.linkOpened || bg.consenting}
                    onChange={(e) => { if (e.currentTarget.checked) bg.recordConsent(); }}
                  />
                </>
              ) : (
                <Text c="dimmed">The background-check link isn&apos;t available yet. Please check back shortly.</Text>
              )}
            </Stack>
          </ExternalTask>
        )}

        <Button variant="default" disabled={saving} onClick={onRefresh} style={{ alignSelf: "flex-start" }}>
          Refresh status
        </Button>
      </Stack>
    </Card>
  );
}
