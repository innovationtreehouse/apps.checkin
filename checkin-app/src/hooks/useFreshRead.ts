import { useCallback, useEffect, useState } from "react";

/** Re-reads when `key` takes a value and reports when it answers: useLoad serves an older cached read first, and a whole-form Save must not send it. */
export function useFreshRead(key: string | number | null, reload: () => Promise<void>) {
  const [freshFor, setFreshFor] = useState<string | number | null>(null);
  useEffect(() => {
    if (key == null) return;
    let cancelled = false;
    reload().then(() => { if (!cancelled) setFreshFor(key); });
    return () => {
      cancelled = true;
      setFreshFor(null);
    };
  }, [key, reload]);
  const retry = useCallback(() => reload().then(() => setFreshFor(key)), [key, reload]);
  return { fresh: key != null && freshFor === key, retry };
}
