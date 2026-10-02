import { describe, expect, it, vi } from "vitest";
import type { LogicalPageSceneDocument } from "../../api/pageScene";

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("../../utils", () => ({ safeFetch }));

import { fetchPageScene, savePageScene } from "../../api/pageScene";

const pageId = "123e4567-e89b-12d3-a456-426614174000";
const scene: LogicalPageSceneDocument = {
  contract_version: "page-scene/v1",
  scene_kind: "logical",
  page: {
    page_id: pageId,
    revision: 0,
    source: { sha256: "a".repeat(64) },
  },
  provenance: {},
  fragments: [],
  owners: [],
  policies: [],
  assets: [],
  cleanup_artifacts: [],
  objects: [
    {
      transform: {
        x: 186.43,
        y: 187.91,
        rotation_degrees: 12.5,
      },
    },
  ],
};

describe("page-scene API adapter", () => {
  it("uses the generated new-format document type without coercing fractional geometry", async () => {
    safeFetch.mockResolvedValueOnce({ ok: true, json: async () => scene });

    await expect(fetchPageScene(pageId, "token123")).resolves.toEqual(scene);
    expect(safeFetch).toHaveBeenCalledWith(`/api/pages/${pageId}/scene`, {
      headers: { Authorization: "Bearer token123" },
    });
    expect(scene.objects[0].transform).toEqual({
      x: 186.43,
      y: 187.91,
      rotation_degrees: 12.5,
    });
  });

  it("sends only logical scenes to the generated PUT endpoint", async () => {
    safeFetch.mockResolvedValueOnce({ ok: true, json: async () => scene });
    const logicalScene = { ...scene, scene_kind: "logical" as const };

    await expect(
      savePageScene(pageId, "token123", logicalScene),
    ).resolves.toEqual(scene);
    expect(safeFetch).toHaveBeenCalledWith(`/api/pages/${pageId}/scene`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer token123",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(logicalScene),
    });
  });
});
