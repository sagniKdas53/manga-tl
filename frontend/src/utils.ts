const stripTrailingSlash = (path: string): string =>
  path.endsWith("/") ? path.slice(0, -1) : path;

/**
 * The app's own route roots, matched on whole path segments.
 *
 * A plain `path.includes("/login")` used to do this, which also matched slugs: a series titled
 * "Login Diaries" lives at `/tlhub/series/7/login-diaries`, and the substring search cut the
 * context path there, yielding `/tlhub/series/7`. That became the router basename, no route
 * matched the URL any more, and the whole app rendered blank. Requiring a `/` or the end of the
 * string after the marker keeps slugs out, and taking the earliest match keeps the answer
 * independent of the order the markers are listed in.
 */
const ROUTE_ROOT = /(?:^|\/)(?:login|series|chapters)(?:\/|$)/;

// Helper to dynamically resolve the context path from the browser address bar
export const getContextPath = (): string => {
  const path = window.location.pathname;

  const match = ROUTE_ROOT.exec(path);
  if (match) {
    return stripTrailingSlash(path.slice(0, match.index));
  }

  // If not on a sub-route, we must be at the base context path root (e.g. "/tlhub/" or "/my/manga/")
  return stripTrailingSlash(path);
};

const STORAGE_KEY = "manga_user";

/** Renew a token once it is this close to expiring. */
const REFRESH_WINDOW_MS = 10 * 60 * 1000;

/**
 * Fired when the stored session can no longer be used. Cancelable: the app calls
 * `preventDefault()` to say it will handle the sign-out itself (router navigation + a toast).
 * When nothing handles it — the React tree crashed, or a request fired after unmount — the
 * fallback below does a hard redirect to the login page so the user is never left staring at
 * a dead screen.
 */
export const SESSION_EXPIRED_EVENT = "session-expired";

/** Fired after a successful renewal, carrying the new token in `detail.token`. */
export const TOKEN_REFRESHED_EVENT = "session-token-refreshed";

export const parseJwt = (token: string) => {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch {
    return null;
  }
};

/** Expiry as epoch milliseconds, or null for a token that carries no readable `exp`. */
export const getTokenExpiry = (token: string): number | null => {
  const claims = parseJwt(token);
  return typeof claims?.exp === "number" ? claims.exp * 1000 : null;
};

export const isTokenExpired = (token: string): boolean => {
  const expiresAt = getTokenExpiry(token);
  return expiresAt !== null && expiresAt <= Date.now();
};

const readStoredToken = (): string | null => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw)?.token ?? null;
  } catch {
    return null;
  }
};

/** Drops the stored session and asks the app to show the login screen. */
export const endSession = (reason: "expired" | "unauthorized"): void => {
  if (localStorage.getItem(STORAGE_KEY) === null) return;
  localStorage.removeItem(STORAGE_KEY);

  const handled = !window.dispatchEvent(
    new CustomEvent(SESSION_EXPIRED_EVENT, {
      cancelable: true,
      detail: { reason },
    }),
  );
  if (!handled) {
    window.location.pathname = getContextPath() + "/login"; // Safely redirects without Open Redirect warning
  }
};

const originalFetch = window.fetch;

/**
 * One renewal at a time. The app fires several requests at once on almost every screen, and each
 * of them used to run its own expiry check and its own `POST /auth/refresh`. That is a burst of
 * redundant logins-in-place whose responses race: the slowest one wins the `localStorage` write,
 * so the session could end up holding an older token than one already handed out.
 */
let inFlightRefresh: Promise<string | null> | null = null;

const requestRefresh = async (token: string): Promise<string | null> => {
  try {
    const res = await originalFetch(getContextPath() + "/api/auth/refresh", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;

    const data = await res.json();
    if (!data?.token) return null;

    const raw = localStorage.getItem(STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) : {};
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...stored, token: data.token }),
    );

    // Components hold the token in React state and send it as an explicit Authorization header,
    // so the write above is not enough on its own — without this the app keeps sending the token
    // it was rendered with and gets logged out anyway, minutes after a successful renewal.
    window.dispatchEvent(
      new CustomEvent(TOKEN_REFRESHED_EVENT, { detail: { token: data.token } }),
    );
    return data.token;
  } catch (err) {
    console.error("[Session] Failed to refresh token", err);
    return null;
  }
};

/**
 * Returns a token that is safe to send, renewing it when it is nearly spent.
 *
 * Callable from anywhere — the request path, a timer, or the moment the tab becomes visible.
 * Renewal used to happen only inside `fetch`, and only if a request happened to be made during
 * the last five minutes of a 24-hour token. Miss that window and the session was simply gone,
 * which is what happens to a tab that sits closed overnight.
 */
export const ensureFreshToken = async (): Promise<string | null> => {
  const token = readStoredToken();
  if (!token) return null;

  const expiresAt = getTokenExpiry(token);
  if (expiresAt === null) return token; // Unreadable expiry: let the server be the judge.

  if (expiresAt <= Date.now()) {
    // The backend refuses to renew an expired token, so there is nothing left to salvage.
    endSession("expired");
    return null;
  }

  if (expiresAt - Date.now() > REFRESH_WINDOW_MS) return token;

  if (!inFlightRefresh) {
    inFlightRefresh = requestRefresh(token).finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
};

/** `setTimeout` truncates its delay to a signed 32-bit int; anything longer fires immediately. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Never re-arm faster than this. Inside the renewal window the ideal delay is zero, so a backend
 * that is refusing to renew would otherwise be retried in a tight loop.
 */
const MIN_RENEWAL_DELAY_MS = 60 * 1000;

/**
 * Milliseconds until the stored token is due for renewal, or null when there is no session to
 * keep alive. Lets a caller arm a single timer for the moment it matters instead of polling.
 */
export const msUntilRenewal = (): number | null => {
  const token = readStoredToken();
  if (!token) return null;

  const expiresAt = getTokenExpiry(token);
  if (expiresAt === null) return null;

  const untilWindow = expiresAt - Date.now() - REFRESH_WINDOW_MS;
  return Math.min(Math.max(untilWindow, MIN_RENEWAL_DELAY_MS), MAX_TIMEOUT_MS);
};

// Override global fetch to prepend the dynamic context path / subfolder base URL to API requests
window.fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  let targetUrl = input;
  const context = getContextPath();
  if (typeof targetUrl === "string" && targetUrl.startsWith("/api")) {
    targetUrl = context + targetUrl;
    if (import.meta.env.DEV) {
      console.log(
        `[Fetch Override] Rewrote API request: ${input} -> ${targetUrl} (detected context: ${context})`,
      );
    }
  }

  // Keep the session alive, and carry any renewed token into this request's own header — the
  // caller captured its copy of the token before we got here.
  if (typeof targetUrl === "string" && !targetUrl.includes("/auth/refresh")) {
    const freshToken = await ensureFreshToken();
    if (freshToken && init?.headers) {
      const headers = new Headers(init.headers);
      if (headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${freshToken}`);
        init = { ...init, headers };
      }
    }
  }

  const MAX_RETRIES = 2;
  let delay = 1000;

  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      const response = await originalFetch(targetUrl, init);
      if (response.status === 401) {
        endSession("unauthorized");
      }

      if (!response.ok && response.status >= 500 && i < MAX_RETRIES) {
        console.warn(
          `[Fetch Retry] 5xx error on ${targetUrl}, retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }

      if (!response.ok && i === MAX_RETRIES) {
        window.dispatchEvent(
          new CustomEvent("api-error", {
            detail: { url: targetUrl, status: response.status },
          }),
        );
      }

      return response;
    } catch (error) {
      if (i < MAX_RETRIES) {
        console.warn(
          `[Fetch Retry] Network error on ${targetUrl}, retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      window.dispatchEvent(
        new CustomEvent("api-error", {
          detail: {
            url: targetUrl,
            error: error instanceof Error ? error.message : "Network error",
          },
        }),
      );
      throw error;
    }
  }

  throw new Error("Unreachable");
};

// Export the configured fetch function
export const safeFetch = window.fetch;

// Slug helper function: Strips unicode punctuation & url-unsafe chars, preserves unicode letters
export function toSlug(text: string): string {
  if (!text) return "manga";
  const cleaned = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-._~]/gu, "") // Fixed: removed unnecessary escape characters to satisfy linting
    .trim()
    .replace(/[-\s]+/g, "-"); // replace spaces/hyphens with single hyphen
  return cleaned || "manga";
}

// Formats cost in a human-friendly format (e.g. $0.00, $0.0045, $0.000001, $2.30e-7)
export function formatCost(cost: number | null | undefined): string {
  if (cost == null) return "N/A";
  if (cost === 0) return "$0.00";
  if (cost >= 0.01) return `$${cost.toFixed(4)}`;
  if (cost >= 0.0001) return `$${cost.toFixed(6)}`;
  return `$${cost.toExponential(2)}`;
}

/**
 * A layer's cost metadata. The same figure lives under three different keys depending on which
 * stage wrote it: OCR creates its own layer and uses the bare `cost`, while translation and QA
 * share one metadata document — QA updates the translation layer rather than creating its own — so
 * they namespace under `tl` and `qa` to avoid colliding.
 */
type CostNode = {
  estimated_cost?: number | null;
  /** How many calls the worker could not price. Absent on payloads written before it reported. */
  unknown_calls?: number | null;
};

export type LayerCostMeta = {
  cost?: CostNode;
  tl?: { cost?: CostNode };
  qa?: { cost?: CostNode };
} | null;

/**
 * Totals every cost a layer carries, and counts the ones that could not be priced.
 *
 * Reading all three keys in one place is the point: this export previously summed `cost` and
 * `qa.cost` but not `tl.cost`, so every translation — the largest line item — was silently missing
 * from the total. A caller that forgets a key is the failure mode, so callers no longer choose.
 *
 * The worker omits `estimated_cost` entirely when it has no price, rather than sending zero. A cost
 * node with no number is therefore "unknown", not "free", and is counted rather than ignored.
 *
 * `unknown_calls` is the authoritative count when present, and says how many calls went unpriced —
 * treating a node reporting eight of them as a single unknown understates the gap. This mirrors
 * `absorb()` in backend-rust/src/export.rs deliberately: the two produce the same totals for the
 * same document, and a client-side export that disagreed with the server's would be worse than
 * either being wrong alone.
 */
export function layerCosts(meta: LayerCostMeta): {
  total: number;
  unpriced: number;
} {
  let total = 0;
  let unpriced = 0;
  if (!meta || typeof meta !== "object") return { total, unpriced };

  for (const node of [meta.cost, meta.tl?.cost, meta.qa?.cost]) {
    if (!node) continue;
    if (typeof node.estimated_cost === "number") total += node.estimated_cost;

    if (typeof node.unknown_calls === "number") unpriced += node.unknown_calls;
    else if (typeof node.estimated_cost !== "number") unpriced += 1;
  }
  return { total, unpriced };
}

export interface ResolvedValue {
  value: string;
  source: "global" | "series" | "chapter";
}

export function resolveOverride(
  chapterVal: string | null | undefined,
  seriesVal: string | null | undefined,
  globalVal: string | null | undefined,
): ResolvedValue {
  if (chapterVal) return { value: chapterVal, source: "chapter" };
  if (seriesVal) return { value: seriesVal, source: "series" };
  return { value: globalVal ?? "", source: "global" };
}

export function formatResolverHint(
  source: "global" | "series" | "chapter",
): string {
  if (source === "series") return "(inherited from series)";
  if (source === "global") return "(global)";
  return "";
}
