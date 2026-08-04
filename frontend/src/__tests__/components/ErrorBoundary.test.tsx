import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../../components/ErrorBoundary";

const Boom = ({ message }: { message: string }) => {
  throw new Error(message);
};

describe("ErrorBoundary", () => {
  let reload: ReturnType<typeof vi.fn>;
  let originalLocation: typeof window.location;

  beforeEach(() => {
    // The boundary logs the caught error; keep the test output readable.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    sessionStorage.clear();
    localStorage.clear();

    reload = vi.fn();
    originalLocation = window.location;
    delete (window as Record<string, unknown>).location;
    window.location = { pathname: "/", reload } as unknown as Location;
  });

  afterEach(() => {
    window.location = originalLocation;
    vi.restoreAllMocks();
  });

  it("shows a recoverable error instead of an empty page", () => {
    render(
      <ErrorBoundary>
        <Boom message="render exploded" />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
  });

  it("reloads once for a stale-build chunk failure", () => {
    render(
      <ErrorBoundary>
        <Boom message="Failed to fetch dynamically imported module: /assets/Reader-a1b2.js" />
      </ErrorBoundary>,
    );

    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("manga_chunk_reload")).not.toBeNull();
  });

  it("does not reload again once the guard is set", () => {
    sessionStorage.setItem("manga_chunk_reload", "1");

    render(
      <ErrorBoundary>
        <Boom message="Failed to fetch dynamically imported module: /assets/Reader-a1b2.js" />
      </ErrorBoundary>,
    );

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("This page is out of date")).toBeInTheDocument();
  });

  it("clears the error when the route changes", () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/series/1">
        <Boom message="render exploded" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKey="/">
        <div>recovered</div>
      </ErrorBoundary>,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });
});
