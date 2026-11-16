"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Card, Group, Text, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";

/**
 * Board-only: the Key Volunteer Agreement's current version, whether its
 * document is in place, and the "new version" action that asks every Key
 * Volunteer to sign again.
 */
export function KeyVolunteerAgreementCard({ initialVersion }: { initialVersion: number }) {
  const [version, setVersion] = useState(initialVersion);
  const [documentConfigured, setDocumentConfigured] = useState<boolean | null>(null);
  const [holders, setHolders] = useState<number | null>(null);
  const [bumping, setBumping] = useState(false);

  useEffect(() => {
    fetch("/api/membership/key-volunteer")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { documentConfigured?: boolean } | null) => setDocumentConfigured(data?.documentConfigured ?? null))
      .catch(() => setDocumentConfigured(null));
    fetch("/api/roles")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { people?: { isKeyVolunteer?: boolean }[] } | null) =>
        setHolders(data?.people ? data.people.filter((p) => p.isKeyVolunteer).length : null))
      .catch(() => setHolders(null));
  }, []);

  const bump = async () => {
    setBumping(true);
    try {
      const res = await fetch("/api/settings/membership/key-volunteer-version", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { agreementVersion?: number; agreementsOpened?: number; error?: string };
      if (!res.ok || data.agreementVersion === undefined) {
        notifications.show({ color: "red", autoClose: false, message: data.error ?? "Failed to start a new agreement version" });
        return;
      }
      setVersion(data.agreementVersion);
      notifications.show({
        color: "green",
        message: `Version ${data.agreementVersion} is current. ${data.agreementsOpened ?? 0} Key Volunteer(s) asked to sign it.`,
      });
    } catch {
      notifications.show({ color: "red", autoClose: false, message: "Network error starting a new agreement version" });
    } finally {
      setBumping(false);
    }
  };

  const confirmBump = () => modals.openConfirmModal({
    title: "Start a new Key Volunteer Agreement version?",
    children: (
      <Text size="sm">
        Use this only for a material change, after the new document is in place.{" "}
        {holders === null ? "Every Key Volunteer" : `${holders} Key Volunteer${holders === 1 ? "" : "s"}`} will be
        asked to sign version {version + 1}. Nobody loses a role, but someone who has not re-signed can&apos;t be
        granted Board, BG reviewer or Finance until they do.
      </Text>
    ),
    labels: { confirm: "Start new version", cancel: "Cancel" },
    confirmProps: { color: "orange" },
    onConfirm: bump,
  });

  return (
    <Card withBorder radius="md" padding="lg">
      <Title order={3} mb="xs">Key Volunteer Agreement</Title>
      <Group gap="sm" mb="sm">
        <Text size="sm">Current version: <strong>{version}</strong></Text>
        {documentConfigured === true && <Badge color="green" variant="light">Document in place</Badge>}
        {documentConfigured === false && <Badge color="red" variant="light">Document not configured</Badge>}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        Key Volunteers sign this agreement once. Start a new version only when the agreement changes materially;
        a wording fix does not need one.
      </Text>
      <Button variant="light" color="orange" loading={bumping} onClick={confirmBump} style={{ alignSelf: "flex-start" }}>
        New version (material change)
      </Button>
    </Card>
  );
}
