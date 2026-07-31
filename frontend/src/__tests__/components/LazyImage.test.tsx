import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LazyImage from "../../components/LazyImage";

describe("LazyImage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not assign its thumbnail URL until it intersects the viewport", () => {
    let onIntersect: IntersectionObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();

    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          onIntersect = callback;
        }
        observe = observe;
        disconnect = disconnect;
        unobserve = vi.fn();
        takeRecords = vi.fn(() => []);
        root = null;
        rootMargin = "400px 0px";
        thresholds = [];
      },
    );

    render(
      <LazyImage
        src="/api/images/thumb/thumbnail"
        alt="Thumbnail"
      />,
    );

    const image = screen.getByAltText("Thumbnail");
    expect(image).not.toHaveAttribute("src");
    expect(observe).toHaveBeenCalledWith(image);

    act(() => {
      onIntersect?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });

    expect(image).toHaveAttribute("src", "/api/images/thumb/thumbnail");
    expect(disconnect).toHaveBeenCalled();
  });
});
