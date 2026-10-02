/** A job's raw error, shortened to the one line the queue panel shows. */
export const formatErrorMessage = (error: string) => {
  if (!error) return "";
  if (
    error.includes("Max retries exceeded") ||
    error.includes("NameResolutionError") ||
    error.includes("Failed to resolve") ||
    error.includes("ConnectionError")
  ) {
    return "Could not connect to internal service (Network Error).";
  }
  if (
    error.includes("500 Server Error") ||
    error.includes("500 Internal Server Error")
  ) {
    return "Internal API returned 500 error.";
  }
  // Status codes are matched outside URLs and as whole numbers: a presigned link's hex signature
  // can contain "401", which once labelled a storage 403 as an invalid API key.
  const text = error.replace(/https?:\/\/\S+/g, "");
  const hasStatus = (code: number) => new RegExp(`\\b${code}\\b`).test(text);
  if (
    hasStatus(402) &&
    (text.includes("Payment Required") || text.includes("Insufficient Quota"))
  ) {
    return "Provider Error (402): Out of credits or payment required.";
  }
  if (hasStatus(404) && text.includes("Not Found")) {
    return "Provider Error (404): Resource or model not found.";
  }
  if (hasStatus(403) && text.includes("Forbidden")) {
    return "Storage Error (403): the download link expired or was refused.";
  }
  if (
    hasStatus(401) ||
    text.includes("Unauthorized") ||
    text.includes("AuthenticationError")
  ) {
    return "Provider Error (401): Invalid API key or unauthorized.";
  }
  const match = error.match(/([a-zA-Z]+Error):\s*(.+)/);
  if (match) return `${match[1]}: ${match[2].substring(0, 100)}`;
  return error.length > 100 ? error.substring(0, 100) + "..." : error;
};
