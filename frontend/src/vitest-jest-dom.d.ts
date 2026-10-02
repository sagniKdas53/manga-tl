// jest-dom 7.0.1 adds its matchers to vitest's one-parameter `Assertion<T>`. Vitest 5's assertions
// take their matchers from `Matchers<R, T>` instead, so that merge no longer applies and every
// `toBeInTheDocument` stopped type-checking. Remove this file once jest-dom ships vitest 5 types.
import "vitest";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the augmentation adds members by extending
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- must match vitest's declaration
    T = unknown,
  > extends TestingLibraryMatchers<unknown, R> {}
}
