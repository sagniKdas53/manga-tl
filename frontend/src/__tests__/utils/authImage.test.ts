import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  clearAuthImageCache,
  prefetchAuthImage,
  useAuthImage,
} from "../../utils/authImage";

const TOKEN = "jwt-token";

/**
 * `utils.ts` captures the real `window.fetch` at import time and exports the wrapped version as a
 * const, so reassigning `global.fetch` in a test does not reach it. Mock the module instead.
 */
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils")>()),
  safeFetch: (...args: unknown[]) => fetchMock(...args),
}));

describe("authImage", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["bytes"]),
    }));
  });

  afterEach(() => {
    clearAuthImageCache();
    vi.restoreAllMocks();
  });

  it("sends the JWT as a header, never in the URL", async () => {
    const { result } = renderHook(() =>
      useAuthImage("/api/images/abc/file", TOKEN),
    );

    await waitFor(() => expect(result.current.src).toMatch(/^blob:/));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/images/abc/file");
    expect(String(url)).not.toContain("token");
    expect((init as RequestInit).headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it("issues one request when a prefetch and a render race for the same page", async () => {
    prefetchAuthImage("/api/images/abc/file", TOKEN);
    const { result } = renderHook(() =>
      useAuthImage("/api/images/abc/file", TOKEN),
    );

    await waitFor(() => expect(result.current.src).toMatch(/^blob:/));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports an error and drops the entry so the next attempt retries", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    const first = renderHook(() => useAuthImage("/api/images/abc/file", TOKEN));
    await waitFor(() => expect(first.result.current.error).toBe(true));
    expect(first.result.current.src).toBeNull();
    first.unmount();

    const second = renderHook(() => useAuthImage("/api/images/abc/file", TOKEN));
    await waitFor(() => expect(second.result.current.src).toMatch(/^blob:/));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not evict the image a mounted reader is displaying", async () => {
    const pinned = "/api/images/pinned/file";
    const { result } = renderHook(() => useAuthImage(pinned, TOKEN));
    await waitFor(() => expect(result.current.src).toMatch(/^blob:/));
    const pinnedSrc = result.current.src;

    // Push well past the 12-entry cap with unrelated prefetches.
    for (let i = 0; i < 30; i++) {
      prefetchAuthImage(`/api/images/other-${i}/file`, TOKEN);
    }
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(31));

    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const rerendered = renderHook(() => useAuthImage(pinned, TOKEN));
    await waitFor(() => expect(rerendered.result.current.src).toBe(pinnedSrc));
    expect(revoke).not.toHaveBeenCalledWith(pinnedSrc);
    // Served from cache: still the original single request for this URL.
    expect(
      fetchMock.mock.calls.filter(([url]) => url === pinned),
    ).toHaveLength(1);
  });

  it("revokes cached blobs when the session is cleared", async () => {
    const { result, unmount } = renderHook(() =>
      useAuthImage("/api/images/abc/file", TOKEN),
    );
    await waitFor(() => expect(result.current.src).toMatch(/^blob:/));
    const src = result.current.src;
    unmount();

    const revoke = vi.spyOn(URL, "revokeObjectURL");
    clearAuthImageCache();
    expect(revoke).toHaveBeenCalledWith(src);
  });
});
