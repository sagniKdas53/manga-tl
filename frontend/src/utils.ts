// Helper to dynamically resolve the context path from the browser address bar
export const getContextPath = (): string => {
  const path = window.location.pathname;
  
  // Check known routes to extract context path prefix
  for (const route of ['/login', '/series', '/chapters']) {
    if (path.includes(route)) {
      let cp = path.substring(0, path.indexOf(route));
      if (cp.endsWith('/')) cp = cp.slice(0, -1);
      return cp;
    }
  }
  
  // If not on a sub-route, we must be at the base context path root (e.g. "/tlhub/" or "/my/manga/")
  let cp = path;
  if (cp.endsWith('/')) cp = cp.slice(0, -1);
  return cp;
};

// Override global fetch to prepend the dynamic context path / subfolder base URL to API requests
const originalFetch = window.fetch;
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  let targetUrl = input;
  const context = getContextPath();
  if (typeof targetUrl === 'string' && targetUrl.startsWith('/api')) {
    targetUrl = context + targetUrl;
    console.log(`[Fetch Override] Rewrote API request: ${input} -> ${targetUrl} (detected context: ${context})`);
  }
  return originalFetch(targetUrl, init).then(response => {
    if (response.status === 401 || response.status === 403) {
      if (localStorage.getItem('manga_user')) {
        localStorage.removeItem('manga_user');
        window.location.pathname = context + '/login'; // Safely redirects without Open Redirect warning
      }
    }
    return response;
  });
};

// Export the configured fetch function
export const safeFetch = window.fetch;

// Slug helper function: Strips unicode punctuation & url-unsafe chars, preserves unicode letters
export function toSlug(text: string): string {
  if (!text) return 'manga';
  const cleaned = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-._~]/gu, '') // Fixed: removed unnecessary escape characters to satisfy linting
    .trim()
    .replace(/[-\s]+/g, '-'); // replace spaces/hyphens with single hyphen
  return cleaned || 'manga';
}
