import { describe, it, expect } from "vitest";
import { formatErrorMessage } from "../../utils/jobErrorMessage";

describe("formatErrorMessage", () => {
  it("does not read a 401 out of a presigned link's signature", () => {
    const expired =
      "403 Client Error: Forbidden for url: http://minio:9000/manga-library/scene-assets/" +
      "e0b39f3b/4d42db.png?X-Amz-Expires=600&X-Amz-Signature=e0d3b1401a870f2";
    expect(formatErrorMessage(expired)).toBe(
      "Storage Error (403): the download link expired or was refused.",
    );
  });

  it("still labels a real 401", () => {
    expect(formatErrorMessage("Error code: 401 - invalid key")).toBe(
      "Provider Error (401): Invalid API key or unauthorized.",
    );
  });
});
