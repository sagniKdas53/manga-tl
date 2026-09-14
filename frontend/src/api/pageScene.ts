import type { components } from "./schema";
import { safeFetch } from "../utils";

export type PageSceneDocument = components["schemas"]["PageSceneDocument"];
export type LogicalPageSceneDocument = Omit<
  PageSceneDocument,
  "scene_kind" | "resolved_layout"
> & {
  scene_kind: "logical";
  resolved_layout?: never;
};

export class PageSceneApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function sceneResponse(response: Response): Promise<PageSceneDocument> {
  if (!response.ok) {
    throw new PageSceneApiError(
      response.status,
      `Page-scene request failed with status ${response.status}`,
    );
  }
  return (await response.json()) as PageSceneDocument;
}

/** Reads the immutable new-format scene for one page revision. */
export async function fetchPageScene(
  pageId: string,
  token: string,
): Promise<PageSceneDocument> {
  return sceneResponse(
    await safeFetch(`/api/pages/${pageId}/scene`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

/** Saves only logical scenes; resolved renderer output is never editor source of truth. */
export async function savePageScene(
  pageId: string,
  token: string,
  scene: LogicalPageSceneDocument,
): Promise<PageSceneDocument> {
  return sceneResponse(
    await safeFetch(`/api/pages/${pageId}/scene`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(scene),
    }),
  );
}
