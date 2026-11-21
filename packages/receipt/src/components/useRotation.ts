"use client";
import { useState } from "react";
import { showError } from "@checkin/component-ui";
import { api, errorMessage } from "./api";

/**
 * A receipt image's turn, starting from the stored `saved` value. Each turn shows at once and
 * saves; a failed save turns the image back and says so. One page shares one hook per receipt,
 * so every copy of that receipt's image turns together.
 */
export function useRotation(receiptId: string, saved = 0): [number, (by: number) => void] {
  const [turned, setTurned] = useState<number | null>(null);
  const turn = turned ?? saved;
  const rotate = (by: number) => {
    const next = (turn + by + 360) % 360;
    setTurned(next);
    api(`/${encodeURIComponent(receiptId)}/rotation`, { method: "PUT", body: JSON.stringify({ rotation: next }) }).catch((err: unknown) => {
      setTurned(turn);
      showError(errorMessage(err), { title: "Couldn't save the rotation" });
    });
  };
  return [turn, rotate];
}
