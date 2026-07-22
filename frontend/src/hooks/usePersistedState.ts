import { useState, useEffect, useCallback } from "react";

export function usePersistedState<T>(
  key: string,
  defaultValue: T,
  options?: {
    serialize?: (val: T) => string;
    deserialize?: (saved: string) => T;
  },
): [T, (val: T | ((prev: T) => T)) => void] {
  const { serialize = String, deserialize } = options || {};

  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved === null) return defaultValue;
      if (deserialize) return deserialize(saved);
      if (typeof defaultValue === "number") {
        const parsed = parseFloat(saved);
        return (isNaN(parsed) ? defaultValue : parsed) as T;
      }
      if (typeof defaultValue === "boolean") return (saved === "true") as T;
      return saved as T;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, serialize(value));
    } catch {
      // Ignore storage errors (quota exceeded, etc.)
    }
  }, [key, value, serialize]);

  const setPersistedValue = useCallback(
    (val: T | ((prev: T) => T)) => {
      setValue(val);
    },
    [],
  );

  return [value, setPersistedValue];
}
