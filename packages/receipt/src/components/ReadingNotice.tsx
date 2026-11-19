"use client";
import { useEffect, useState } from "react";
import { Alert } from "@mantine/core";

export const READING_STATES: ReadonlySet<string> = new Set(["ocr_queued", "auto_upload"]);
const READING_POLL_EVERY_MS = 3_000;
const READING_POLL_FOR_MS = 3 * 60_000;

/** Shown while the receipt waits to be read or is being read: reloads it every 3 seconds for 3 minutes. */
export default function ReadingNotice({ state, reload }: { state: string; reload: () => unknown }) {
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started < READING_POLL_FOR_MS) return void reload();
      clearInterval(timer);
      setStopped(true);
    }, READING_POLL_EVERY_MS);
    return () => clearInterval(timer);
  }, [reload]);
  const now = state === "ocr_queued" ? "Saved. Waiting to be read." : "Saved. Reading it now.";
  return <Alert color="blue">{stopped ? "Still reading. This page updates when you reload it." : now}</Alert>;
}
