/**
 * Badge scans as the kiosk sends them. Under CHECKIN_ENV=local a request with no cookie is the
 * keyless kiosk, and the test makes the decisions the kiosk would make.
 */
import { randomUUID } from "node:crypto";
import { SCAN_PROTOCOL_VERSION } from "@/lib/scanProtocol";
import { api } from "../../flow-tests/helpers";

export interface ScanOptions {
  intent: "IN" | "OUT";
  close?: "alone" | "confirmed";
  rosterAsOf?: Date;
  replay?: boolean;
  scannedAt?: Date;
}

export interface ScanReply {
  type?: string;
  message?: string;
  facilityClosed?: boolean;
  closeRefused?: boolean;
  closePrompt?: string;
  visit?: { facilityCloseId: number | null };
}

/** A seeded or minted person, found by email. */
export async function persona(email: string): Promise<{ id: number; name: string }> {
  const { json } = await api<{ personas: Array<{ id: number; name: string; email: string }> }>(null, `/api/auth/dev-personas?q=${encodeURIComponent(email)}`);
  const found = json.personas.find((p) => p.email === email);
  if (!found) throw new Error(`dev persona not found: ${email}`);
  return found;
}

/** Sends the scan with this event id, as a kiosk does when it never got the first reply. */
export async function resend(eventId: string, email: string, { intent, close, rosterAsOf, replay, scannedAt }: ScanOptions) {
  const { id } = await persona(email);
  const { status, json } = await api<ScanReply>(null, "/api/scan", {
    method: "POST",
    body: JSON.stringify({
      participantId: id,
      clientEventId: eventId,
      protocolVersion: SCAN_PROTOCOL_VERSION,
      intent,
      close,
      rosterAsOf: rosterAsOf?.toISOString(),
      replay,
      scannedAt: scannedAt?.toISOString(),
    }),
  });
  return { eventId, status, json };
}

/** One badge read, with a fresh event id. */
export const scan = (email: string, options: ScanOptions) => resend(randomUUID(), email, options);
