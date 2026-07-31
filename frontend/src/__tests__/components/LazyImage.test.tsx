import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("retries with a cache-busting query param when loading fails", () => {
    let onIntersect: IntersectionObserverCallback | undefined;

    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          onIntersect = callback;
        }
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
        takeRecords = vi.fn(() => []);
        root = null;
        rootMargin = "400px 0px";
        thresholds = [];
      },
    );

    vi.useFakeTimers();

    render(<LazyImage src="/api/images/thumb/thumbnail" alt="Thumbnail" />);

    const image = screen.getByAltText("Thumbnail");
    act(() => {
      onIntersect?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });

    expect(image).toHaveAttribute("src", "/api/images/thumb/thumbnail");

    fireEvent.error(image);
    expect(image).toHaveAttribute("src", "/api/images/thumb/thumbnail");

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(image).toHaveAttribute("src", "/api/images/thumb/thumbnail?retry=1");

    fireEvent.error(image);
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(image).toHaveAttribute("src", "/api/images/thumb/thumbnail?retry=2");
  });
});
