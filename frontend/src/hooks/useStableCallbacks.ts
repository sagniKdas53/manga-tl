import { useLayoutEffect, useRef, useState } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Callbacks = Record<string, ((...args: any[]) => any) | undefined>;

/**
 * Wrappers that keep one identity for the component's lifetime and always call the latest
 * version of each callback.
 *
 * The Reader hands its sidebars dozens of handlers that close over page state, so most are new
 * functions on every render and `React.memo` on the sidebars never skipped a render: dragging the
 * zoom slider re-rendered the 2,000-line inspector on every tick (2026-10-04). Passing these
 * wrappers instead lets a sidebar skip renders whose visible props did not change.
 *
 * Only for callbacks called from events or effects, never during render: a wrapper reads the
 * callbacks from the last commit. The set of keys must not change between renders.
 */
export function useStableCallbacks<T extends Callbacks>(callbacks: T): T {
  const latest = useRef(callbacks);
  useLayoutEffect(() => {
    latest.current = callbacks;
  });
  const [stable] = useState(() => {
    const wrappers: Callbacks = {};
    for (const key of Object.keys(callbacks)) {
      wrappers[key] = (...args: unknown[]) => latest.current[key]?.(...args);
    }
    return wrappers as T;
  });
  return stable;
}
