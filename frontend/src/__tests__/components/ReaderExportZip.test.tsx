import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import JSZip from "jszip";
import Reader from "../../components/Reader";

/**
 * The project ZIP export, opened and read back.
 *
 * This existed as an untested silent failure mode: the export was repointed at `/file` so
 * `original.png` would be the original rather than the lossy reading variant, and `/file` was
 * confirmed to still serve untouched bytes — but nothing checked that the archive it produces
 * is one you can actually open, or that it fetches the original at all.
 *
 * What is covered: the archive parses, its entry list is complete, `project.json` round-trips
 * with the page's real layer/element data, and the original is fetched from the `/file` URL
 * rather than the `/reader` variant.
 *
 * What is NOT covered: pixel content. jsdom has no canvas, so `toBlob` is stubbed and the PNG
 * bytes here are placeholders. Anything about how the page actually *looks* has to be checked
 * against a real browser.
 */

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useParams: vi.fn(() => ({ pageNumber: "22" })),
}));

vi.mock("../../components/useNotifications", () => ({
  useNotifications: () => ({
    notifications: [],
    subscribe: vi.fn(() => vi.fn()),
  }),
}));

const mockShowToast = vi.fn();
vi.mock("../../components/ToastContext", () => ({
  useToast: () => ({
    showToast: mockShowToast,
    showSuccess: vi.fn(),
    showError: vi.fn(),
  }),
}));

const mockSafeFetch = vi.fn();
vi.mock("../../utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils")>();
  return {
    ...actual,
    safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  };
});

const mockUser = {
  id: "u1",
  username: "tester",
  email: "t@t.com",
  displayName: "tester",
  role: "translator",
  token: "token123",
};
const mockSeries = {
  id: "s1",
  title: "One Piece",
  coverImageUrl: "",
  readingDirection: "rtl",
  originalLanguage: "ja",
  sourceLanguage: "ja",
  targetLanguage: "en",
  chaptersCount: 1,
  imageId: "img1",
  slug: "one-piece",
};
const mockChapter = {
  id: "c1",
  seriesId: "s1",
  chapterNumber: 11,
  title: "Romance Dawn",
  status: "COMPLETED",
  pagesCount: 1,
};
const mockPage = {
  id: "p1",
  chapterId: "c1",
  pageNumber: 22,
  imageId: "img1",
  filename: "22.jpg",
  status: "COMPLETED",
  imagePath: "/path",
  processingProgress: 100,
  url: "/api/images/img1/file",
};

const layerPayload = [
  {
    layer: {
      id: "layer-1",
      type: "translation",
      targetLanguage: "en",
      visible: true,
      zOrder: 1,
      metadataJson: { cost: { estimated_cost: 0.0125 } },
    },
    elements: [
      {
        id: "el-1",
        text: "Am I... going to be taken too...??",
        font: "Comic Neue",
        size: 16,
        autoSize: true,
        x: 61,
        y: 665,
        maxWidth: 69,
        maxHeight: 509,
        rotation: 0,
        visible: true,
        wordWrap: true,
        backgroundColor: "#ffffff",
        textColor: "#000000",
        fontWeight: "bold",
        fontStyle: "normal",
        isManuallyEdited: false,
        boxShape: "rectangular",
        maskPolygon: null,
        regionId: "r1",
      },
    ],
  },
  // An OCR layer, so the export path has one to leave out. It is working state: its rasters must
  // never reach the archive, while project.json still carries it so a re-import is lossless.
  {
    layer: {
      id: "layer-ocr",
      type: "ocr",
      targetLanguage: null,
      visible: true,
      zOrder: 0,
      metadataJson: {},
    },
    elements: [
      {
        id: "el-ocr-1",
        text: "\u79c1\u306f\u2026",
        font: "Comic Neue",
        size: 16,
        autoSize: true,
        x: 61,
        y: 665,
        maxWidth: 69,
        maxHeight: 509,
        rotation: 0,
        visible: true,
        wordWrap: true,
        backgroundColor: "#ffffff",
        textColor: "#000000",
        fontWeight: "normal",
        fontStyle: "normal",
        isManuallyEdited: false,
        boxShape: "rectangular",
        maskPolygon: null,
        regionId: "r1",
      },
    ],
  },
];

/** Enough of a 2d context for the export path to run; none of it produces real pixels. */
function stubCanvas() {
  const ctx = {
    font: "",
    fillStyle: "",
    textAlign: "",
    textBaseline: "",
    measureText: (t: string) => ({ width: t.length * 8 }),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    ellipse: vi.fn(),
    fillRect: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillText: vi.fn(),
  };
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ctx,
  ) as unknown as HTMLCanvasElement["getContext"];
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(
      new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
        type: "image/png",
      }),
    );
  } as HTMLCanvasElement["toBlob"];
}

describe("Reader project ZIP export", () => {
  let capturedZip: Blob | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedZip = null;
    stubCanvas();

    Object.defineProperty(Image.prototype, "decode", {
      value: () => Promise.resolve(),
      configurable: true,
      writable: true,
    });

    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      (obj: Blob | MediaSource) => {
        // The last object URL minted is the archive itself; the originals come first.
        if (obj instanceof Blob && obj.type === "application/zip")
          capturedZip = obj;
        return "blob:http://localhost/zip";
      },
    );

    mockSafeFetch.mockImplementation((url: string) => {
      // Layers and original dimensions both arrive on the page-details response.
      if (typeof url === "string" && /\/api\/pages\/[^/]+$/.test(url)) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              panels: [],
              ocrRegions: [],
              conversations: [],
              layers: layerPayload,
              image: { width: 1200, height: 1600 },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
        blob: () =>
          Promise.resolve(new Blob(["original-bytes"], { type: "image/jpeg" })),
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads the current immutable render artifact instead of drawing a canvas", async () => {
    // Tracker R1: the PNG export is the browser renderer's artifact for the page's current
    // revision. Nothing here may touch a canvas, and the request must go to /rendered.
    render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={[mockPage]}
        theme="dark"
      />,
    );

    const img = await screen.findByAltText(`Page ${mockPage.pageNumber}`);
    fireEvent.load(img);
    fireEvent.click(await screen.findByText("Export Page (PNG)"));

    await waitFor(() => {
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    });
    const renderedRequest = mockSafeFetch.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].endsWith(`/api/pages/${mockPage.id}/rendered`),
    );
    expect(renderedRequest).toBeDefined();
    expect(renderedRequest?.[1]).toMatchObject({ cache: "no-store" });
    const contexts = vi
      .mocked(HTMLCanvasElement.prototype.getContext)
      .mock.results.map((result) => result.value)
      .filter((context) => context !== null);
    const paintedText = contexts
      .flatMap((context) => vi.mocked(context!.fillText).mock.calls)
      .map((call: unknown[]) => String(call[0]))
      .join(" ");
    expect(paintedText).toBe("");
  });

  /** /rendered answers 409 until POST /render has run; POST /render answers `renderStatus`. */
  function mockPendingRender(renderStatus: number) {
    let rendered = false;
    mockSafeFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (
        typeof url === "string" &&
        url.endsWith("/render") &&
        init?.method === "POST"
      ) {
        rendered = renderStatus === 200;
        return Promise.resolve({
          ok: renderStatus === 200,
          status: renderStatus,
          json: () =>
            Promise.resolve(
              renderStatus === 200
                ? { status: "succeeded", revision: 4 }
                : { status: "pending", error: "the page renderer stayed busy" },
            ),
        });
      }
      if (typeof url === "string" && url.endsWith("/rendered")) {
        return Promise.resolve(
          rendered
            ? {
                ok: true,
                status: 200,
                blob: () =>
                  Promise.resolve(new Blob(["png"], { type: "image/png" })),
              }
            : {
                ok: false,
                status: 409,
                json: () => Promise.resolve({ status: "pending", revision: 4 }),
              },
        );
      }
      if (typeof url === "string" && /\/api\/pages\/[^/]+$/.test(url)) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              panels: [],
              ocrRegions: [],
              conversations: [],
              layers: layerPayload,
              image: { width: 1200, height: 1600 },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
  }

  async function exportPng() {
    render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={[mockPage]}
        theme="dark"
      />,
    );
    const img = await screen.findByAltText(`Page ${mockPage.pageNumber}`);
    fireEvent.load(img);
    fireEvent.click(await screen.findByText("Export Page (PNG)"));
  }

  it("renders a page whose render is pending, then exports it", async () => {
    // User review 2026-10-02: Export used to say "try again in a few seconds" while an edit
    // waited for the render debounce and a worker. It now asks for the render and waits.
    mockPendingRender(200);
    await exportPng();

    await waitFor(() => {
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    });
    const renderCall = mockSafeFetch.mock.calls.find((call) =>
      String(call[0]).endsWith(`/api/pages/${mockPage.id}/render`),
    );
    expect(renderCall?.[1]).toMatchObject({ method: "POST" });
  });

  it("says so when the renderer cannot take the page now, and exports nothing else", async () => {
    mockPendingRender(503);
    await exportPng();

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/renderer is busy/i),
        "error",
      );
    });
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it("produces an archive that opens, with the expected entries and a readable project.json", async () => {
    render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={[mockPage]}
        theme="dark"
      />,
    );

    const img = await screen.findByAltText(`Page ${mockPage.pageNumber}`);
    Object.defineProperty(img, "naturalWidth", {
      value: 1200,
      configurable: true,
    });
    Object.defineProperty(img, "naturalHeight", {
      value: 1600,
      configurable: true,
    });
    fireEvent.load(img);

    fireEvent.click(await screen.findByText("Export Project (ZIP)"));

    await waitFor(() => {
      expect(capturedZip).not.toBeNull();
    });

    // The real check: hand the bytes back to a zip reader and see if they open.
    const zip = await JSZip.loadAsync(capturedZip!);
    const names = Object.keys(zip.files).sort();

    expect(names).toContain("original.png");
    expect(names).toContain("project.json");
    expect(names).toContain("layer-layer-1-mask.png");
    expect(names).toContain("layer-layer-1-translation.png");

    // An OCR layer is working state; it is drawn on screen and never rasterised into an export.
    // This used to depend on the `cleanScanlationView` overlay toggle, so a downloaded file's
    // contents changed with a view setting.
    expect(names).not.toContain("layer-layer-ocr-mask.png");
    expect(names).not.toContain("layer-layer-ocr-translation.png");
    expect(names.filter((n) => n.includes("ocr"))).toEqual([]);

    const project = JSON.parse(await zip.file("project.json")!.async("string"));
    // Tracker R7-D3: version 2 carries the Inpainting layer; version 1 is refused on import.
    expect(project.schemaVersion).toBe(2);
    expect(project.pageNumber).toBe(22);
    expect(project.imageId).toBe("img1");
    expect(project.dimensions).toEqual({ width: 1200, height: 1600 });
    // Both layers survive into project.json -- only the rasters are filtered.
    expect(project.layers).toHaveLength(2);
    expect(project.layers.map((l: { type: string }) => l.type).sort()).toEqual([
      "ocr",
      "translation",
    ]);
    const translation = project.layers.find(
      (l: { type: string }) => l.type === "translation",
    );
    expect(translation.elements[0].text).toBe(
      "Am I... going to be taken too...??",
    );
    // Cost is summed out of each layer's metadata rather than stored, so a change in that
    // shape would silently zero it.
    expect(project.totalCost.estimated_cost).toBeCloseTo(0.0125);
  });

  it("carries the Inpainting layer: each patch file by digest, and each patch's edits", async () => {
    const patchSha = "a".repeat(64);
    const maskSha = "b".repeat(64);
    const inpainting = {
      layer: {
        id: "layer-inpaint",
        type: "inpainting",
        visible: true,
        zOrder: -1,
        metadataJson: {},
        createdAt: "2026-09-27T00:00:00Z",
      },
      elements: [
        {
          id: "patch-1",
          layerId: "layer-inpaint",
          regionId: "r1",
          x: 70,
          y: 660,
          maxWidth: 80,
          maxHeight: 500,
          rotation: 0,
          visible: false,
          autoSize: false,
          wordWrap: false,
          overflow: false,
          isManuallyEdited: false,
          opacity: 0.5,
          cleanupRef: {
            patchSha256: patchSha,
            patchByteLength: 3,
            maskSha256: maskSha,
            maskByteLength: 3,
            generatorSha256: "0".repeat(64),
            bounds: { x: 61, y: 665, width: 69, height: 509 },
            order: 0,
          },
        },
      ],
    };
    const assetBytes: Record<string, string> = {
      [patchSha]: "patch-bytes",
      [maskSha]: "mask-bytes",
    };
    const fallback = mockSafeFetch.getMockImplementation()!;
    mockSafeFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && /\/api\/pages\/[^/]+$/.test(url)) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              panels: [],
              // r1 has a patch and its text a polygon, which is exported as it is (G4: a polygon is
              // the fit shape, not a plate); r9 has a patch but no usable English, so R7-D4 does
              // not paint it.
              ocrRegions: [
                {
                  id: "r1",
                  text: "x",
                  translatedText: "Am I...",
                  cleanupPatchSha256: patchSha,
                },
                {
                  id: "r9",
                  text: "y",
                  translatedText: null,
                  cleanupPatchSha256: patchSha,
                },
              ],
              conversations: [],
              layers: [
                {
                  ...layerPayload[0],
                  elements: [
                    {
                      ...layerPayload[0].elements[0],
                      maskPolygon: "[[61,665],[130,665],[130,1174],[61,1174]]",
                    },
                  ],
                },
                layerPayload[1],
                {
                  ...inpainting,
                  elements: [
                    ...inpainting.elements,
                    {
                      ...inpainting.elements[0],
                      id: "patch-9",
                      regionId: "r9",
                      visible: true,
                    },
                  ],
                },
              ],
              image: { width: 1200, height: 1600 },
            }),
        });
      }
      const asset =
        typeof url === "string"
          ? /scene-assets\/([0-9a-f]{64})$/.exec(url)
          : null;
      if (asset) {
        return Promise.resolve({
          ok: true,
          blob: () =>
            Promise.resolve(
              new Blob([assetBytes[asset[1]]], { type: "image/png" }),
            ),
        });
      }
      return fallback(url, init);
    });

    render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={[mockPage]}
        theme="dark"
      />,
    );
    const img = await screen.findByAltText(`Page ${mockPage.pageNumber}`);
    fireEvent.load(img);
    fireEvent.click(await screen.findByText("Export Project (ZIP)"));
    await waitFor(() => expect(capturedZip).not.toBeNull());

    const zip = await JSZip.loadAsync(capturedZip!);
    const names = Object.keys(zip.files);
    // A hidden patch is history, and history round-trips too.
    expect(await zip.file(`cleanup/${patchSha}.png`)!.async("string")).toBe(
      "patch-bytes",
    );
    expect(await zip.file(`cleanup/${maskSha}.png`)!.async("string")).toBe(
      "mask-bytes",
    );
    expect(names.filter((n) => n.includes("layer-inpaint"))).toEqual([]);
    const project = JSON.parse(await zip.file("project.json")!.async("string"));
    const layer = project.layers.find(
      (l: { type: string }) => l.type === "inpainting",
    );
    expect(layer.elements[0]).toMatchObject({
      x: 70,
      y: 660,
      maxWidth: 80,
      maxHeight: 500,
      visible: false,
      opacity: 0.5,
      cleanupRef: { patchSha256: patchSha, maskSha256: maskSha, order: 0 },
    });
    // The region's verdicts are baked in: an imported page has no regions to ask.
    expect(layer.elements[1]).toMatchObject({ id: "patch-9", visible: false });
    const text = project.layers.find(
      (l: { type: string }) => l.type === "translation",
    );
    expect(text.elements[0].maskPolygon).toBe(
      "[[61,665],[130,665],[130,1174],[61,1174]]",
    );
  });

  it("reads the original from /file, not the lossy reader variant", async () => {
    render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={[mockPage]}
        theme="dark"
      />,
    );

    const img = await screen.findByAltText(`Page ${mockPage.pageNumber}`);
    fireEvent.load(img);
    fireEvent.click(await screen.findByText("Export Project (ZIP)"));

    await waitFor(() => {
      expect(capturedZip).not.toBeNull();
    });

    const requested = mockSafeFetch.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/api/images/img1/"));

    expect(requested).toContain("/api/images/img1/file");
    expect(requested.some((u) => u.endsWith("/reader"))).toBe(false);
  });
});
