import { useEffect, useRef } from "react";

/**
 * Hook to log tracked value changes after a component render.
 * Only runs in development mode.
 * @param deps - The dependencies object to check for changes.
 * @param componentName - The name of the component for logging context.
 */
export const useDependencyLogger = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps: Record<string, any>,
  componentName: string = "component"
) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prevDepsRef = useRef<Record<string, any> | undefined>(undefined);

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const prev = prevDepsRef.current;

    if (!prev) {
      console.log(`[render] ${componentName} initial values:`, deps);
    } else {
      const changed = Object.keys(deps).filter(
        (key) => !Object.is(prev[key], deps[key])
      );

      if (changed.length) {
        console.group(
          `[render] ${componentName} values changed: ${changed.join(", ")}`
        );
        changed.forEach((key) => {
          console.log(key, "prev:", prev[key], "curr:", deps[key]);
        });
        console.groupEnd();
      }
    }

    prevDepsRef.current = { ...deps };
  });
};
