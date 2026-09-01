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

vi.mock("../../components/ToastContext", () => ({
  useToast: () => ({
    showToast: vi.fn(),
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

  it("never paints OCR text into the canvas PNG export", async () => {
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
    fireEvent.click(await screen.findByText("Export Page (PNG)"));

    await waitFor(() => {
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    });
    const contexts = vi
      .mocked(HTMLCanvasElement.prototype.getContext)
      .mock.results.map((result) => result.value)
      .filter((context) => context !== null);
    expect(contexts.length).toBeGreaterThan(0);
    const renderedText = vi
      .mocked(contexts[0]!.fillText)
      .mock.calls.map(([text]) => String(text))
      .join(" ");
    expect(renderedText).toContain("Am I");
    expect(renderedText).not.toContain("\u79c1\u306f");
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
