import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Replace `window.location` for the duration of a test.
 *
 * `delete window.location` then assigning needs two casts to typecheck -- `window` is not a
 * `Record<string, unknown>`, and the DOM lib types the location setter as `string & Location`.
 * `defineProperty` is what the assignment desugars to anyway, and it needs neither.
 */
const stubLocation = (value: unknown) => {
  Object.defineProperty(window, "location", {
    value,
    writable: true,
    configurable: true,
  });
};

describe("safeFetch", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalLocation: typeof window.location;
  let safeFetch: typeof window.fetch;

  beforeEach(async () => {
    // We must mock window.fetch BEFORE importing utils so that originalFetch captures the mock
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    localStorage.clear();

    // Safely mock window.location
    originalLocation = window.location;
    stubLocation({
      pathname: "",
      href: "http://localhost/",
      origin: "http://localhost",
      host: "localhost",
      protocol: "http:",
    });

    // Dynamically import utils to ensure it picks up the mocked global.fetch
    vi.resetModules();
    const utils = await import("../../utils");
    safeFetch = utils.safeFetch;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    stubLocation(originalLocation);
    vi.restoreAllMocks();
  });

  it("should attempt refresh on token near expiry", async () => {
    const twoMinutesFromNow = Math.floor(Date.now() / 1000) + 120;
    const mockPayload = btoa(JSON.stringify({ exp: twoMinutesFromNow }));
    const expiringToken = `header.${mockPayload}.signature`;

    localStorage.setItem(
      "manga_user",
      JSON.stringify({ token: expiringToken }),
    );

    const mockRefreshResponse = {
      ok: true,
      json: () => Promise.resolve({ token: "new-token" }),
    };
    const mockTargetResponse = {
      ok: true,
      status: 200,
    };

    mockFetch
      .mockResolvedValueOnce(mockRefreshResponse)
      .mockResolvedValueOnce(mockTargetResponse);

    await safeFetch("http://localhost/api/test");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const refreshCallUrl = mockFetch.mock.calls[0][0];
    expect(refreshCallUrl).toContain("/api/auth/refresh");

    const storedUser = JSON.parse(localStorage.getItem("manga_user") || "{}");
    expect(storedUser.token).toBe("new-token");
  });

  it("refreshes once when several requests race the expiry window", async () => {
    const twoMinutesFromNow = Math.floor(Date.now() / 1000) + 120;
    const mockPayload = btoa(JSON.stringify({ exp: twoMinutesFromNow }));
    localStorage.setItem(
      "manga_user",
      JSON.stringify({ token: `header.${mockPayload}.sig` }),
    );

    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes("/auth/refresh")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ token: "new-token" }),
        });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    await Promise.all([
      safeFetch("http://localhost/api/a"),
      safeFetch("http://localhost/api/b"),
      safeFetch("http://localhost/api/c"),
    ]);

    const refreshCalls = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("/auth/refresh"),
    );
    expect(refreshCalls).toHaveLength(1);
  });

  it("rewrites the outgoing Authorization header with the refreshed token", async () => {
    const twoMinutesFromNow = Math.floor(Date.now() / 1000) + 120;
    const mockPayload = btoa(JSON.stringify({ exp: twoMinutesFromNow }));
    const staleToken = `header.${mockPayload}.sig`;
    localStorage.setItem("manga_user", JSON.stringify({ token: staleToken }));

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ token: "new-token" }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await safeFetch("http://localhost/api/test", {
      headers: { Authorization: `Bearer ${staleToken}` },
    });

    const sentInit = mockFetch.mock.calls[1][1] as RequestInit;
    expect(new Headers(sentInit.headers).get("Authorization")).toBe(
      "Bearer new-token",
    );
  });

  it("announces the token renewal so React state can follow", async () => {
    const twoMinutesFromNow = Math.floor(Date.now() / 1000) + 120;
    const mockPayload = btoa(JSON.stringify({ exp: twoMinutesFromNow }));
    localStorage.setItem(
      "manga_user",
      JSON.stringify({ token: `header.${mockPayload}.sig` }),
    );

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ token: "new-token" }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const listener = vi.fn();
    window.addEventListener("session-token-refreshed", listener);
    await safeFetch("http://localhost/api/test");
    window.removeEventListener("session-token-refreshed", listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail.token).toBe(
      "new-token",
    );
  });

  it("ends the session instead of sending a request with an expired token", async () => {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const mockPayload = btoa(JSON.stringify({ exp: oneHourAgo }));
    localStorage.setItem(
      "manga_user",
      JSON.stringify({ token: `header.${mockPayload}.sig` }),
    );

    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const listener = vi.fn();
    window.addEventListener("session-expired", listener);
    await safeFetch("http://localhost/api/test");
    window.removeEventListener("session-expired", listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail.reason).toBe(
      "expired",
    );
    expect(localStorage.getItem("manga_user")).toBeNull();
    // No doomed refresh attempt: the backend will not renew a token that is already dead.
    expect(
      mockFetch.mock.calls.some((c) => String(c[0]).includes("/auth/refresh")),
    ).toBe(false);
  });

  it("leaves the redirect to the app when a listener claims the expiry", async () => {
    localStorage.setItem(
      "manga_user",
      JSON.stringify({ token: "invalid-token" }),
    );
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const listener = (e: Event) => e.preventDefault();
    window.addEventListener("session-expired", listener);
    await safeFetch("http://localhost/api/test");
    window.removeEventListener("session-expired", listener);

    expect(localStorage.getItem("manga_user")).toBeNull();
    expect(window.location.pathname).toBe("");
  });

  it("should clear localStorage and redirect to /login on 401 response", async () => {
    localStorage.setItem(
      "manga_user",
      JSON.stringify({ token: "invalid-token" }),
    );

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

describe("msUntilRenewal", () => {
  const tokenExpiringIn = (seconds: number) =>
    `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }))}.sig`;

  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when there is no session to keep alive", async () => {
    const { msUntilRenewal } = await import("../../utils");
    expect(msUntilRenewal()).toBeNull();
  });

  it("aims at the start of the renewal window", async () => {
    const { msUntilRenewal } = await import("../../utils");
    localStorage.setItem(
      "manga_user",
      JSON.stringify({ token: tokenExpiringIn(24 * 60 * 60) }),
    );

    // 24h token, renewed 10 minutes before expiry: one wake-up, ~23h50m out.
    const delay = msUntilRenewal();
    expect(delay).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(delay).toBeLessThanOrEqual(23 * 60 * 60 * 1000 + 50 * 60 * 1000);
  });

  it("floors the delay so a refusing backend is not retried in a tight loop", async () => {
    const { msUntilRenewal } = await import("../../utils");
    localStorage.setItem(
      "manga_user",
      JSON.stringify({ token: tokenExpiringIn(120) }),
    );

    // Already inside the window: the ideal delay is zero, which must not be honoured.
    expect(msUntilRenewal()).toBe(60 * 1000);
  });
});

describe("getContextPath", () => {
  let originalLocation: typeof window.location;

  const withPath = async (pathname: string) => {
    vi.resetModules();
    stubLocation({
      pathname,
      href: `http://localhost${pathname}`,
    });
    const { getContextPath } = await import("../../utils");
    return getContextPath();
  };

  beforeEach(() => {
    originalLocation = window.location;
  });

  afterEach(() => {
    stubLocation(originalLocation);
  });

  it("strips the app's own route roots", async () => {
    expect(await withPath("/tlhub/login")).toBe("/tlhub");
    expect(await withPath("/tlhub/series/7")).toBe("/tlhub");
    expect(await withPath("/tlhub/chapters/9/reader/3")).toBe("/tlhub");
    expect(await withPath("/login")).toBe("");
  });

  it("returns the path itself when no route root is present", async () => {
    expect(await withPath("/tlhub/")).toBe("/tlhub");
    expect(await withPath("/my/manga/")).toBe("/my/manga");
    expect(await withPath("/")).toBe("");
  });

  it("does not mistake a slug for a route root", async () => {
    // A series titled "Login Diaries" used to cut the context path at its slug, which left the
    // router with a basename no URL matched — a blank app.
    expect(await withPath("/tlhub/series/7/login-diaries")).toBe("/tlhub");
    expect(await withPath("/tlhub/chapters/9/series-finale/reader/1")).toBe(
      "/tlhub",
    );
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
    expect(resolveOverride("chap", "ser", "glob")).toEqual({
      value: "chap",
      source: "chapter",
    });
    expect(resolveOverride(null, "ser", "glob")).toEqual({
      value: "ser",
      source: "series",
    });
    expect(resolveOverride(null, null, "glob")).toEqual({
      value: "glob",
      source: "global",
    });
    expect(resolveOverride(null, null, null)).toEqual({
      value: "",
      source: "global",
    });
  });

  it("formatResolverHint formats hint string", async () => {
    const { formatResolverHint } = await import("../../utils");
    expect(formatResolverHint("series")).toBe("(inherited from series)");
    expect(formatResolverHint("global")).toBe("(global)");
    expect(formatResolverHint("chapter")).toBe("");
  });
});

describe("layerCosts", () => {
  it("counts translation cost, which lives under tl.cost", async () => {
    const { layerCosts } = await import("../../utils");
    // The regression this guards: the ZIP export summed `cost` and `qa.cost` but never `tl.cost`,
    // so every translation — the largest line item — was silently missing from the total.
    expect(layerCosts({ tl: { cost: { estimated_cost: 0.02 } } })).toEqual({
      total: 0.02,
      unpriced: 0,
    });
  });

  it("sums all three keys a layer can carry", async () => {
    const { layerCosts } = await import("../../utils");
    const result = layerCosts({
      cost: { estimated_cost: 0.01 },
      tl: { cost: { estimated_cost: 0.02 } },
      qa: { cost: { estimated_cost: 0.03 } },
    });
    expect(result.total).toBeCloseTo(0.06);
    expect(result.unpriced).toBe(0);
  });

  it("treats a cost with no number as unknown rather than free", async () => {
    const { layerCosts } = await import("../../utils");
    // The worker omits estimated_cost entirely when it could not price the job, so a cost node
    // with no number means "unknown". Silently reading it as 0 is what made unpriced work look
    // free all the way through to the dashboard.
    const result = layerCosts({
      cost: { estimated_cost: 0.01 },
      tl: { cost: {} },
    });
    expect(result.total).toBeCloseTo(0.01);
    expect(result.unpriced).toBe(1);
  });

  it("handles absent or malformed metadata", async () => {
    const { layerCosts } = await import("../../utils");
    expect(layerCosts(null)).toEqual({ total: 0, unpriced: 0 });
    expect(layerCosts({})).toEqual({ total: 0, unpriced: 0 });
  });

  it("uses unknown_calls as the count when the payload reports it", async () => {
    const { layerCosts } = await import("../../utils");
    // A node that could not price eight calls is eight unknowns, not one. Counting the node
    // instead of the calls understates the gap, and would disagree with what export.rs publishes
    // for the very same document.
    const result = layerCosts({ tl: { cost: { unknown_calls: 8 } } });
    expect(result.total).toBe(0);
    expect(result.unpriced).toBe(8);
  });

  it("counts unknown_calls even alongside a priced total", async () => {
    const { layerCosts } = await import("../../utils");
    const result = layerCosts({
      cost: { estimated_cost: 0.01, unknown_calls: 2 },
      qa: { cost: { estimated_cost: 0.02, unknown_calls: 0 } },
    });
    expect(result.total).toBeCloseTo(0.03);
    expect(result.unpriced).toBe(2);
  });
});
