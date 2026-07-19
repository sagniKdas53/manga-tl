// Helper to dynamically resolve the context path from the browser address bar
export const getContextPath = (): string => {
  const path = window.location.pathname;

  // Check known routes to extract context path prefix
  for (const route of ["/login", "/series", "/chapters"]) {
    if (path.includes(route)) {
      let cp = path.substring(0, path.indexOf(route));
      if (cp.endsWith("/")) cp = cp.slice(0, -1);
      return cp;
    }
  }

  // If not on a sub-route, we must be at the base context path root (e.g. "/tlhub/" or "/my/manga/")
  let cp = path;
  if (cp.endsWith("/")) cp = cp.slice(0, -1);
  return cp;
};

// Override global fetch to prepend the dynamic context path / subfolder base URL to API requests
const originalFetch = window.fetch;
window.fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  let targetUrl = input;
  const context = getContextPath();
  if (typeof targetUrl === "string" && targetUrl.startsWith("/api")) {
    targetUrl = context + targetUrl;
    console.log(
      `[Fetch Override] Rewrote API request: ${input} -> ${targetUrl} (detected context: ${context})`,
    );
  }

  const MAX_RETRIES = 2;
  let delay = 1000;

  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      const response = await originalFetch(targetUrl, init);
      if (response.status === 401) {
        if (localStorage.getItem("manga_user")) {
          localStorage.removeItem("manga_user");
          window.location.pathname = context + "/login"; // Safely redirects without Open Redirect warning
        }
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
