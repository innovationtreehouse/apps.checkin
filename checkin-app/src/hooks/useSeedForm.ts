import { useState } from "react";

/** Seeds form state from each new answer, unless `dirty`: a refetch never overwrites unsaved input. */
export function useSeedForm<T>(data: T | null, dirty: boolean, seed: (answer: T) => void): void {
  const [seededFrom, setSeededFrom] = useState<T | null>(null);
  if (data !== null && data !== seededFrom) {
    setSeededFrom(data);
    if (!dirty) seed(data);
  }
}
