import { useEffect, useRef } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Deps = Record<string, any>;

const useDevLogger = (deps: Deps, componentName: string) => {
  const prevDepsRef = useRef<Deps | undefined>(undefined);
  const prev = prevDepsRef.current;

  useEffect(() => {
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

const noop = () => {};

export const useDependencyLogger = import.meta.env.DEV
  ? useDevLogger
  : noop;
