"use client";
import { useEffect, useState } from "react";
import { ActionIcon, Group, Image, Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage } from "./api";

const BOX = 600;

/**
 * A file as its route serves it: an image or PDF displays from `src`; text is fetched and shown
 * as escaped text, never rendered as a page. An image shows turned by `rotation`; with
 * `rotationPath` it also offers buttons that turn it and save the turn there.
 */
export default function ReceiptFile({
  src,
  mimeType,
  title = "Receipt",
  rotation = 0,
  rotationPath,
}: {
  src: string;
  mimeType: string;
  title?: string;
  rotation?: number;
  rotationPath?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const [turn, setTurn] = useState(rotation);
  useEffect(() => setTurn(rotation), [rotation]);
  useEffect(() => {
    if (mimeType !== "text/plain") return;
    void fetch(src).then((r) => (r.ok ? r.text() : `Couldn't load the file (HTTP ${r.status})`)).then(setText);
  }, [src, mimeType]);
  if (mimeType === "application/pdf") return <iframe src={src} title={title} style={{ width: "100%", height: BOX, border: 0 }} />;
  if (mimeType === "text/plain") return <pre style={{ whiteSpace: "pre-wrap", maxHeight: BOX, overflow: "auto" }}>{text ?? "Loading…"}</pre>;

  const rotate = async (path: string, by: number) => {
    const before = turn;
    const next = (before + by + 360) % 360;
    setTurn(next);
    try {
      await api(path, { method: "PUT", body: JSON.stringify({ rotation: next }) });
    } catch (err) {
      setTurn(before);
      notifications.show({ title: "Couldn't save the rotation", message: errorMessage(err), color: "red", autoClose: false });
    }
  };
  const sideways = turn === 90 || turn === 270;
  const image = sideways ? (
    // A sideways image swaps its width and height on screen, so it is bounded by the box's
    // height across and the box's width down, and centred so the turn stays inside the box.
    <div style={{ width: "100%", height: BOX, containerType: "size", display: "grid", placeItems: "center" }}>
      <Image src={src} alt={title} fit="contain" style={{ maxWidth: "100cqh", maxHeight: "100cqw", width: "auto", transform: `rotate(${turn}deg)` }} />
    </div>
  ) : (
    <Image src={src} alt={title} mah={BOX} fit="contain" style={turn ? { transform: `rotate(${turn}deg)` } : undefined} />
  );
  if (!rotationPath) return image;
  return (
    <Stack gap={4}>
      <Group gap={4} justify="flex-end">
        <ActionIcon variant="default" aria-label="Rotate left" onClick={() => void rotate(rotationPath, -90)}>↺</ActionIcon>
        <ActionIcon variant="default" aria-label="Rotate right" onClick={() => void rotate(rotationPath, 90)}>↻</ActionIcon>
      </Group>
      {image}
    </Stack>
  );
}
