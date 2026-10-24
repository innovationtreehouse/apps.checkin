"use client";
import { useEffect, useState } from "react";
import { Image } from "@mantine/core";

/**
 * A file as its route serves it: an image or PDF displays from `src`; text is fetched and shown
 * as escaped text, never rendered as a page.
 */
export default function ReceiptFile({ src, mimeType }: { src: string; mimeType: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (mimeType !== "text/plain") return;
    void fetch(src).then((r) => (r.ok ? r.text() : `Couldn't load the file (HTTP ${r.status})`)).then(setText);
  }, [src, mimeType]);
  if (mimeType === "application/pdf") return <iframe src={src} title="Receipt" style={{ width: "100%", height: 600, border: 0 }} />;
  if (mimeType === "text/plain") return <pre style={{ whiteSpace: "pre-wrap", maxHeight: 600, overflow: "auto" }}>{text ?? "Loading…"}</pre>;
  return <Image src={src} alt="Receipt" mah={600} fit="contain" />;
}
