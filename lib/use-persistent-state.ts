"use client";
import { useEffect, useState } from "react";

// localStorage-backed useState. SSR-safe: renders `initial` on first paint (so
// server HTML matches client), then hydrates from localStorage after mount.
// ponytail: writes on every change — payloads are a few KB, setItem is microseconds; add debounce only if a hot field proves it.
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);

  // Restore once on mount (client only).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) setValue(JSON.parse(raw) as T);
    } catch {
      /* corrupt/blocked storage → keep defaults */
    }
    setHydrated(true);
  }, [key]);

  // Persist on change — but NOT before hydration, or we'd write the default
  // over saved data before restore runs. `hydrated` starts false so the
  // first commit skips the write.
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota / private mode → skip */
    }
  }, [key, value, hydrated]);

  return [value, setValue] as const;
}
