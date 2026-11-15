"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";

type SelfStatus = { owesSignature: boolean; agreementVersion: number; requestStarted: boolean; documentConfigured: boolean };

/**
 * "Sign Key Volunteer Agreement", shown while the caller has an open agreement.
 * Zoho returns the signer with ?kva=signed or ?kva=declined; on return this pulls
 * the signature from Zoho rather than waiting on the webhook.
 */
export default function KeyVolunteerAgreementPanel() {
  const [status, setStatus] = useState<SelfStatus | null>(null);
  const [signing, setSigning] = useState(false);
  const returnHandled = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const kvaReturn = returnHandled.current ? null : params.get("kva");
    if (kvaReturn) {
      returnHandled.current = true;
      params.delete("kva");
      const rest = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    }
    const load = kvaReturn === "signed"
      ? fetch("/api/membership/key-volunteer/sync", { method: "POST" })
      : fetch("/api/membership/key-volunteer");
    load
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SelfStatus | null) => {
        setStatus(data);
        if (kvaReturn === "signed") {
          notifications.show({
            message: data && !data.owesSignature
              ? "Thanks — your Key Volunteer Agreement signature was received."
              : "Signature received — finalizing. Reload the page shortly to see it.",
          });
        } else if (kvaReturn === "declined") {
          notifications.show({ color: "red", autoClose: false, message: "You declined the Key Volunteer Agreement. You can sign it when you're ready." });
        }
      })
      .catch(() => setStatus(null));
  }, []);

  if (!status?.owesSignature) return null;

  const sign = async () => {
    setSigning(true);
    try {
      const res = await fetch("/api/membership/key-volunteer/sign", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { signUrl?: string; error?: string };
      if (res.ok && data.signUrl) {
        window.location.href = data.signUrl;
        return;
      }
      notifications.show({ color: "red", autoClose: false, message: data.error ?? "Couldn't open the signing form. Please try again." });
    } catch {
      notifications.show({ color: "red", autoClose: false, message: "Network error opening the signing form." });
    }
    setSigning(false);
  };

  return (
    <Card withBorder radius="md" padding="lg" mb="lg" maw={640}>
      <Title order={2}>Sign the Key Volunteer Agreement</Title>
      <Text c="dimmed" my="md">
        The Board has made you a Key Volunteer. Please sign the Key Volunteer Agreement
        (version {status.agreementVersion}).
      </Text>
      {status.documentConfigured ? (
        <Button loading={signing} onClick={sign}>
          {status.requestStarted ? "Resume signing →" : "Sign Key Volunteer Agreement →"}
        </Button>
      ) : (
        <Text c="dimmed" size="sm">The agreement isn&apos;t ready to sign yet. Please check back soon.</Text>
      )}
    </Card>
  );
}
