import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("safeFetch", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalLocation: typeof window.location;
  let safeFetch: any;

  beforeEach(async () => {
    // We must mock window.fetch BEFORE importing utils so that originalFetch captures the mock
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    
    localStorage.clear();
    
    // Safely mock window.location
    originalLocation = window.location;
    delete (window as any).location;
    window.location = { 
      pathname: '', 
      href: 'http://localhost/', 
      origin: 'http://localhost',
      host: 'localhost',
      protocol: 'http:'
    } as any;

    // Dynamically import utils to ensure it picks up the mocked global.fetch
    vi.resetModules();
    const utils = await import("./utils");
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
