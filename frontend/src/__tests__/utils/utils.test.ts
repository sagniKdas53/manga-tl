import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("safeFetch", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalLocation: typeof window.location;
  let safeFetch: typeof window.fetch;

  beforeEach(async () => {
    // We must mock window.fetch BEFORE importing utils so that originalFetch captures the mock
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    
    localStorage.clear();
    
    // Safely mock window.location
    originalLocation = window.location;
    delete (window as Record<string, unknown>).location;
    window.location = { 
      pathname: '', 
      href: 'http://localhost/', 
      origin: 'http://localhost',
      host: 'localhost',
      protocol: 'http:'
    } as unknown as Location;

    // Dynamically import utils to ensure it picks up the mocked global.fetch
    vi.resetModules();
    const utils = await import("../../utils");
    safeFetch = utils.safeFetch;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.location = originalLocation;
    vi.restoreAllMocks();
  });

  it("should attempt refresh on token near expiry", async () => {
    const twoMinutesFromNow = Math.floor(Date.now() / 1000) + 120;
    const mockPayload = btoa(JSON.stringify({ exp: twoMinutesFromNow }));
    const expiringToken = `header.${mockPayload}.signature`;

    localStorage.setItem("manga_user", JSON.stringify({ token: expiringToken }));

    const mockRefreshResponse = {
      ok: true,
      json: () => Promise.resolve({ token: "new-token" }),
    };
    const mockTargetResponse = {
      ok: true,
      status: 200,
    };

    mockFetch.mockResolvedValueOnce(mockRefreshResponse).mockResolvedValueOnce(mockTargetResponse);

    await safeFetch("http://localhost/api/test");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const refreshCallUrl = mockFetch.mock.calls[0][0];
    expect(refreshCallUrl).toContain("/api/auth/refresh");

    const storedUser = JSON.parse(localStorage.getItem("manga_user") || "{}");
    expect(storedUser.token).toBe("new-token");
  });

  it("should clear localStorage and redirect to /login on 401 response", async () => {
    localStorage.setItem("manga_user", JSON.stringify({ token: "invalid-token" }));

    const mockUnauthResponse = {
      ok: false,
      status: 401,
    };

    mockFetch.mockResolvedValueOnce(mockUnauthResponse);

    await safeFetch("http://localhost/api/test");

    expect(localStorage.getItem("manga_user")).toBeNull();
    expect(window.location.pathname).toContain("/login");
  });

  it("should not refresh token if not near expiry", async () => {
    const twentyMinutesFromNow = Math.floor(Date.now() / 1000) + 1200;
    const mockPayload = btoa(JSON.stringify({ exp: twentyMinutesFromNow }));
    const validToken = `header.${mockPayload}.signature`;

    localStorage.setItem("manga_user", JSON.stringify({ token: validToken }));

    const mockTargetResponse = {
      ok: true,
      status: 200,
    };

    mockFetch.mockResolvedValueOnce(mockTargetResponse);

    await safeFetch("http://localhost/api/test");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const targetCallUrl = mockFetch.mock.calls[0][0];
    expect(targetCallUrl).toContain("http://localhost/api/test");
  });
});

describe("utils helpers", () => {
  it("toSlug converts strings correctly", async () => {
    const { toSlug } = await import("../../utils");
    expect(toSlug("")).toBe("manga");
    expect(toSlug("Hello World! 123")).toBe("hello-world-123");
  });

  it("formatCost formats numbers properly", async () => {
    const { formatCost } = await import("../../utils");
    expect(formatCost(null)).toBe("N/A");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.05)).toBe("$0.0500");
    expect(formatCost(0.0005)).toBe("$0.000500");
    expect(formatCost(0.00000023)).toBe("$2.30e-7");
  });

  it("resolveOverride respects fallback precedence", async () => {
    const { resolveOverride } = await import("../../utils");
    expect(resolveOverride("chap", "ser", "glob")).toEqual({ value: "chap", source: "chapter" });
    expect(resolveOverride(null, "ser", "glob")).toEqual({ value: "ser", source: "series" });
    expect(resolveOverride(null, null, "glob")).toEqual({ value: "glob", source: "global" });
    expect(resolveOverride(null, null, null)).toEqual({ value: "", source: "global" });
  });

  it("formatResolverHint formats hint string", async () => {
    const { formatResolverHint } = await import("../../utils");
    expect(formatResolverHint("series")).toBe("(inherited from series)");
    expect(formatResolverHint("global")).toBe("(global)");
    expect(formatResolverHint("chapter")).toBe("");
  });
});
