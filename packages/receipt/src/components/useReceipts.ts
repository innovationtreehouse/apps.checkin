"use client";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "./api";

function without<V>(map: Map<string, V>, id: string): Map<string, V> {
  const next = new Map(map);
  next.delete(id);
  return next;
}

/** Loads each receipt in `ids` on its own, so one that is slow or fails doesn't hide the rest. */
export function useReceipts<T extends { id: string }>(ids: string[]): { loaded: Map<string, T>; errors: Map<string, string>; reload: () => void } {
  const key = ids.join(",");
  const [loaded, setLoaded] = useState(new Map<string, T>());
  const [errors, setErrors] = useState(new Map<string, string>());
  const [round, setRound] = useState(0);
  const reload = useCallback(() => setRound((n) => n + 1), []);
  useEffect(() => {
    const wanted = key ? key.split(",") : [];
    let stale = false;
    for (const id of wanted) {
      api<T>(`/${encodeURIComponent(id)}`).then(
        (receipt) => {
          if (stale) return;
          setLoaded((prior) => new Map(prior).set(id, receipt));
          setErrors((prior) => without(prior, id));
        },
        (err: unknown) => {
          if (stale) return;
          setLoaded((prior) => without(prior, id));
          setErrors((prior) => new Map(prior).set(id, errorMessage(err)));
        },
      );
    }
    return () => {
      stale = true;
    };
  }, [key, round]);
  return { loaded, errors, reload };
}
