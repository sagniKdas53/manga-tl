import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
  cleanup,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Reader from "../../components/Reader";
import { clearSceneAssetCache } from "../../utils/inpainting";

/**
 * Tracker R7: the editor draws the cleaned page. Each cleanup patch is an <image> on the Inpainting
 * layer, painted after the page image and before every text layer (ContentScene's order), and it
 * replaces the flat plate for its region. Hide, delete and undo act on the patch alone.
 *
 * jsdom does not rasterise, so this pins structure and requests; the pixel comparison against the
 * export is the Playwright parity run in the R7 checkpoint.
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

const PATCH = "a".repeat(64);
const MASK = "b".repeat(64);
const cleanupRef = {
  patchSha256: PATCH,
  patchByteLength: 3,
  maskSha256: MASK,
  maskByteLength: 3,
  generatorSha256: "0".repeat(64),
  bounds: { x: 50, y: 60, width: 120, height: 80 },
  order: 0,
};
const textElement = (id: string, regionId: string, polygon: string | null) => ({
  id,
  text: "Hello",
  font: "Comic Neue",
  size: 16,
  autoSize: true,
  x: 50,
  y: 60,
  maxWidth: 120,
  maxHeight: 80,
  rotation: 0,
  visible: true,
  wordWrap: true,
  backgroundColor: "#ffffff",
  textColor: "#000000",
  fontWeight: "bold",
  fontStyle: "normal",
  isManuallyEdited: false,
  boxShape: "rectangular",
  maskPolygon: polygon,
  regionId,
});
const patchElement = {
  id: "patch-el",
  layerId: "layer-inpaint",
  regionId: "r1",
  autoSize: false,
  wordWrap: false,
  rotation: 0,
  x: 50,
  y: 60,
  maxWidth: 120,
  maxHeight: 80,
  visible: true,
  overflow: false,
  isManuallyEdited: false,
  opacity: 0.6,
  cleanupRef,
};
const pageDetails = () => ({
  panels: [],
  conversations: [],
  image: { width: 1200, height: 1600 },
  ocrRegions: [
    {
      id: "r1",
      text: "やあ",
      translatedText: "Hello",
      bubbleReadingOrder: 1,
      panelReadingOrder: 1,
      bboxX: 50,
      bboxY: 60,
      bboxW: 120,
      bboxH: 80,
      cleanupPatchSha256: PATCH,
    },
    {
      id: "r2",
      text: "ねえ",
      translatedText: "Hey",
      bubbleReadingOrder: 2,
      panelReadingOrder: 1,
      bboxX: 300,
      bboxY: 400,
      bboxW: 100,
      bboxH: 60,
      cleanupPatchSha256: null,
    },
  ],
  layers: [
    {
      layer: {
        id: "layer-tl",
        type: "translation",
        targetLanguage: "en",
        visible: true,
        zOrder: 1,
        createdAt: "2026-09-27T00:00:00Z",
      },
      elements: [
        {
          ...textElement("el-1", "r1", "[[50,60],[170,60],[170,140],[50,140]]"),
          layerId: "layer-tl",
        },
        {
          ...textElement(
            "el-2",
            "r2",
            "[[300,400],[400,400],[400,460],[300,460]]",
          ),
          layerId: "layer-tl",
        },
        // Region-less text (manual or imported): the export never plates it, so neither may the editor.
        {
          ...textElement(
            "el-3",
            "",
            "[[500,500],[600,500],[600,560],[500,560]]",
          ),
          regionId: null,
          layerId: "layer-tl",
        },
      ],
    },
    {
      layer: {
        id: "layer-inpaint",
        type: "inpainting",
        visible: true,
        zOrder: 0,
        createdAt: "2026-09-27T00:00:00Z",
      },
      elements: [patchElement],
    },
  ],
});

const renderReader = async () => {
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
  await waitFor(() =>
    expect(
      document.querySelector('[data-cleanup-id="cleanup-patch-el"]'),
    ).not.toBeNull(),
  );
};

const calls = (method: string, pattern: RegExp) =>
  mockSafeFetch.mock.calls.filter(
    ([url, init]) =>
      typeof url === "string" &&
      pattern.test(url) &&
      ((init as RequestInit | undefined)?.method ?? "GET") === method,
  );

describe("Reader Inpainting layer (tracker R7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSceneAssetCache();
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      () => `blob:patch-${PATCH.slice(0, 6)}`,
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    mockSafeFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (/\/api\/pages\/[^/]+$/.test(url)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(pageDetails()),
        });
      }
      if (url.includes("/scene-assets/")) {
        return Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob(["png"], { type: "image/png" })),
        });
      }
      if (
        /\/api\/layers\/layer-inpaint\/elements$/.test(url) &&
        init?.method === "POST"
      ) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ ...patchElement, id: "patch-el-restored" }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks a flagged region only while Show debug is on, never over the reading views", async () => {
    // 2026-09-30: with the debug boxes off, flagged regions still got amber outlines, and Clean
    // Scanlation drew them over the finished page. Debug on is where they show (in the box
    // colour); the Issues list finds them either way.
    const base = mockSafeFetch.getMockImplementation()!;
    mockSafeFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (/\/api\/pages\/[^/]+$/.test(url)) {
        const details = pageDetails();
        Object.assign(details.ocrRegions[1], { qaStatus: "failed" });
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(details),
        });
      }
      return base(url, init);
    });
    const outlines = () =>
      Array.from(document.querySelectorAll(".svg-overlay title")).filter((t) =>
        t.textContent?.startsWith("Needs a look"),
      ).length;
    const flaggedBoxes = () =>
      Array.from(
        document.querySelectorAll<SVGRectElement>(".svg-overlay .svg-ocr-box"),
      ).filter((box) =>
        ["#ef4444", "rgb(239, 68, 68)"].includes(box.style.stroke),
      ).length;
    try {
      localStorage.setItem("manga_clean_view", "false");
      localStorage.setItem("manga_show_ocr", "true");
      await renderReader();
      expect(flaggedBoxes()).toBe(1);
      cleanup();

      for (const clean of ["false", "true"]) {
        localStorage.setItem("manga_show_ocr", "false");
        localStorage.setItem("manga_clean_view", clean);
        await renderReader();
        expect(outlines()).toBe(0);
        expect(flaggedBoxes()).toBe(0);
        cleanup();
      }
    } finally {
      localStorage.removeItem("manga_show_ocr");
      localStorage.removeItem("manga_clean_view");
    }
  });

  it("paints the patch after the page image and before any text, as the export does", async () => {
    await renderReader();
    const overlay = document.querySelector(".svg-overlay")!;
    const cleanup = overlay.querySelector('[data-scene-layer="cleanup"]')!;
    const image = cleanup.querySelector("image")!;
    expect(image.getAttribute("href")).toMatch(/^blob:/);
    expect(image.getAttribute("preserveAspectRatio")).toBe("none");
    expect(image.getAttribute("opacity")).toBe("0.6");
    expect([
      image.getAttribute("x"),
      image.getAttribute("y"),
      image.getAttribute("width"),
      image.getAttribute("height"),
    ]).toEqual(["50", "60", "120", "80"]);
    // The first child group of the overlay: nothing (text, plates, OCR boxes) is under it.
    expect(overlay.firstElementChild).toBe(cleanup);
    // Fetched with the JWT: <image href> cannot send one.
    const [, init] = calls("GET", /\/api\/pages\/p1\/scene-assets\/a{64}$/)[0];
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer token123",
    });
  });

  it("drops the flat plate where the region has a patch, and keeps it where cleanup gave none", async () => {
    await renderReader();
    const plates = [...document.querySelectorAll(".svg-overlay polygon")].map(
      (p) => p.getAttribute("points"),
    );
    expect(plates).toEqual(["300,400 400,400 400,460 300,460"]);
  });

  it("always saves a patch's opacity, so Undo back to unset is opaque on the server too", async () => {
    const details = pageDetails();
    details.layers[1].elements[0] = {
      ...patchElement,
      opacity: null as unknown as number,
    };
    mockSafeFetch.mockImplementation((url: string) => {
      if (/\/api\/pages\/[^/]+$/.test(url)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(details),
        });
      }
      if (url.includes("/scene-assets/")) {
        return Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob(["png"], { type: "image/png" })),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    await renderReader();
    fireEvent.click(
      document.querySelector('[data-cleanup-id="cleanup-patch-el"]')!,
    );
    fireEvent.click(await screen.findByText("Hide patch"));
    await waitFor(() =>
      expect(calls("PUT", /\/api\/layer-elements\/patch-el$/)).toHaveLength(1),
    );
    const [, init] = calls("PUT", /\/api\/layer-elements\/patch-el$/)[0];
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      visible: false,
      opacity: 1,
    });
  });

  it("hides, deletes and undoes a patch without touching the text", async () => {
    await renderReader();
    fireEvent.click(
      document.querySelector('[data-cleanup-id="cleanup-patch-el"]')!,
    );
    fireEvent.click(await screen.findByText("Hide patch"));
    await waitFor(() =>
      expect(
        document.querySelector('[data-cleanup-id="cleanup-patch-el"]'),
      ).toBeNull(),
    );
    const [, hideInit] = calls("PUT", /\/api\/layer-elements\/patch-el$/).at(
      -1,
    )!;
    expect(JSON.parse((hideInit as RequestInit).body as string)).toMatchObject({
      visible: false,
      opacity: 0.6,
    });
    expect(calls("PUT", /\/api\/layer-elements\/el-1$/)).toHaveLength(0);

    // Undo shows it again.
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-cleanup-id="cleanup-patch-el"]'),
      ).not.toBeNull(),
    );

    // Delete is one undo step: no confirmation, and Ctrl+Z re-creates it from its snapshot.
    fireEvent.click(
      document.querySelector('[data-cleanup-id="cleanup-patch-el"]')!,
    );
    fireEvent.click(await screen.findByText("Delete patch"));
    await waitFor(() =>
      expect(calls("DELETE", /\/api\/layer-elements\/patch-el$/)).toHaveLength(
        1,
      ),
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-cleanup-id="cleanup-patch-el"]'),
      ).toBeNull(),
    );
    expect(document.querySelectorAll(".svg-overlay polygon")).toHaveLength(1);

    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-cleanup-id="cleanup-patch-el-restored"]'),
      ).not.toBeNull(),
    );
    const [, restoreInit] = calls(
      "POST",
      /\/api\/layers\/layer-inpaint\/elements$/,
    )[0];
    expect(
      JSON.parse((restoreInit as RequestInit).body as string),
    ).toMatchObject({
      x: 50,
      y: 60,
      maxWidth: 120,
      maxHeight: 80,
      opacity: 0.6,
      regionId: "r1",
      cleanupRef: { patchSha256: PATCH },
    });

    // Redo deletes the restored copy again.
    await act(async () => {
      fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    });
    await waitFor(() =>
      expect(
        calls("DELETE", /\/api\/layer-elements\/patch-el-restored$/),
      ).toHaveLength(1),
    );
  });

  it("keeps a hidden OCR layer's regions selectable without painting its Japanese", async () => {
    // OCR layers are created hidden (2026-09-28). The region tools follow the newest OCR pass and
    // its redo overlays whatever their visibility; an older pass stays out.
    const ocrElement = (id: string, regionId: string, layerId: string) => ({
      ...textElement(id, regionId, null),
      text: "やあ",
      backgroundColor: null,
      layerId,
    });
    const ocrLayer = (id: string, zOrder: number, overlay = false) => ({
      id,
      type: "ocr",
      visible: false,
      zOrder,
      createdAt: "2026-09-27T00:00:00Z",
      metadataJson: overlay ? { overlay: true } : {},
    });
    const details = pageDetails();
    details.ocrRegions.push({ ...details.ocrRegions[1], id: "r-old" });
    (details.layers as unknown[]).push(
      {
        layer: ocrLayer("layer-ocr-old", -2),
        elements: [ocrElement("ocr-old", "r-old", "layer-ocr-old")],
      },
      {
        layer: ocrLayer("layer-ocr", -1),
        elements: [ocrElement("ocr-1", "r1", "layer-ocr")],
      },
      {
        layer: ocrLayer("layer-ocr-redo", 2, true),
        elements: [ocrElement("ocr-2", "r2", "layer-ocr-redo")],
      },
    );
    mockSafeFetch.mockImplementation((url: string) => {
      if (/\/api\/pages\/[^/]+$/.test(url)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(details),
        });
      }
      if (url.includes("/scene-assets/")) {
        return Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob(["png"], { type: "image/png" })),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await renderReader();
    const overlay = document.querySelector(".svg-overlay")!;
    await waitFor(() =>
      expect(overlay.querySelectorAll(".svg-ocr-box")).toHaveLength(2),
    );
    expect(overlay.textContent).not.toContain("やあ");
  });
});

describe("Mask editor (inpainting view)", () => {
  // jsdom has no canvas: a stand-in where each canvas keeps the dots filled on it as marked
  // pixels, honouring the two composite operations the editor uses.
  let marks = new WeakMap<HTMLCanvasElement, Set<string>>();
  const marksOf = (canvas: HTMLCanvasElement) => {
    if (!marks.has(canvas)) marks.set(canvas, new Set());
    return marks.get(canvas)!;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearSceneAssetCache();
    marks = new WeakMap();
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:asset");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement) {
        const [canvas] = [this];
        let lastArc: { x: number; y: number } | null = null;
        const ctx = {
          font: "",
          globalCompositeOperation: "source-over",
          measureText: (text: string) => ({
            width: text.length * 8,
            actualBoundingBoxAscent: 10,
            actualBoundingBoxDescent: 3,
          }),
          beginPath: () => {},
          moveTo: () => {},
          lineTo: () => {},
          stroke: () => {},
          arc: (x: number, y: number) => {
            lastArc = { x: Math.round(x), y: Math.round(y) };
          },
          fill: () => {
            if (!lastArc) return;
            const key = `${lastArc.x},${lastArc.y}`;
            if (ctx.globalCompositeOperation === "destination-out")
              marksOf(canvas).delete(key);
            else marksOf(canvas).add(key);
          },
          clearRect: () => marksOf(canvas).clear(),
          drawImage: (source: HTMLCanvasElement) => {
            for (const key of marksOf(source)) {
              if (ctx.globalCompositeOperation === "destination-out")
                marksOf(canvas).delete(key);
              else marksOf(canvas).add(key);
            }
          },
          putImageData: () => {},
          createImageData: (width: number, height: number) => ({
            data: new Uint8ClampedArray(width * height * 4),
            width,
            height,
          }),
          getImageData: () => {
            const data = new Uint8ClampedArray(
              canvas.width * canvas.height * 4,
            );
            for (const key of marksOf(canvas)) {
              const [x, y] = key.split(",").map(Number);
              data[(y * canvas.width + x) * 4 + 3] = 255;
            }
            return { data, width: canvas.width, height: canvas.height };
          },
        };
        return ctx as unknown as CanvasRenderingContext2D;
      } as unknown as HTMLCanvasElement["getContext"],
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,AAAA",
    );
    mockSafeFetch.mockImplementation((url: string) => {
      if (/\/api\/pages\/[^/]+$/.test(url)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(pageDetails()),
        });
      }
      if (url.includes("/scene-assets/")) {
        return Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob(["png"], { type: "image/png" })),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 202,
        json: () => Promise.resolve({ queued: true }),
        text: () => Promise.resolve(""),
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds the box of what was painted and turns it into a white mask", async () => {
    const { markBounds, binaryMask } =
      await import("../../utils/inpaintingMask");
    const rgba = new Uint8ClampedArray(6 * 4 * 4);
    rgba[(1 * 6 + 2) * 4 + 3] = 128;
    rgba[(2 * 6 + 4) * 4 + 3] = 255;
    expect(markBounds(rgba, 6, 4)).toEqual({ x: 2, y: 1, width: 3, height: 2 });
    expect(markBounds(new Uint8ClampedArray(6 * 4 * 4), 6, 4)).toBeNull();
    const mask = binaryMask(rgba, 6, { x: 2, y: 1, width: 3, height: 2 });
    expect(Array.from(mask.slice(0, 4))).toEqual([255, 255, 255, 255]);
    expect(mask[3 * 4 + 3]).toBe(0);
  });

  it("opens from the Inpainting layer, hides the text, tints the masks, and applies a brushed mark", async () => {
    await renderReader();
    const overlay = document.querySelector(".svg-overlay")!;
    await waitFor(() => expect(overlay.textContent).toContain("Hello"));

    await act(async () => {
      fireEvent.click(screen.getByText("Inpainting"));
    });
    const toolbar = await screen.findByRole("toolbar", {
      name: "Inpainting tools",
    });
    expect(overlay.textContent).not.toContain("Hello");
    expect(overlay.querySelectorAll(".svg-ocr-box")).toHaveLength(0);
    await waitFor(() =>
      expect(
        overlay.querySelector('[data-mask-tint="patch-el"]'),
      ).not.toBeNull(),
    );
    expect(
      calls("GET", new RegExp(`/api/pages/p1/scene-assets/${MASK}$`)),
    ).toHaveLength(1);

    const canvas = screen.getByTestId("inpainting-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 1200,
      height: 1600,
      right: 1200,
      bottom: 1600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 110, clientY: 205, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 110, clientY: 205, pointerId: 1 });
    await waitFor(() => expect(apply).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(apply);
    });
    await waitFor(() =>
      expect(calls("POST", /\/api\/pages\/p1\/manual-cleanup$/)).toHaveLength(
        1,
      ),
    );
    const [, init] = calls("POST", /\/api\/pages\/p1\/manual-cleanup$/)[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      mask: "data:image/png;base64,AAAA",
      bounds: { x: 100, y: 200, width: 11, height: 6 },
      method: "auto",
    });
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.stringContaining("Repaint queued"),
      "info",
    );

    fireEvent.click(
      Array.from(toolbar.querySelectorAll("button")).find(
        (button) => button.textContent === "Done",
      )!,
    );
    await waitFor(() => expect(overlay.textContent).toContain("Hello"));
    expect(screen.queryByTestId("inpainting-canvas")).toBeNull();
  });

  it("puts its tools in the sidebar's place, never pans while painting, and restores what the eraser marks", async () => {
    await renderReader();
    const overlay = document.querySelector(".svg-overlay")!;
    await waitFor(() => expect(overlay.textContent).toContain("Hello"));
    await act(async () => {
      fireEvent.click(screen.getByText("Inpainting"));
    });
    const panel = await screen.findByRole("toolbar", {
      name: "Inpainting tools",
    });
    // The panel is the sidebar now: nothing floats over the page.
    expect(screen.getByTestId("inpainting-panel-host").contains(panel)).toBe(
      true,
    );
    expect(document.querySelector(".reader-right-sidebar-nhentai")).toBe(panel);

    // The patch list highlights a patch on the page.
    const row = panel.querySelector('[data-patch-row="patch-el"]')!;
    expect(row.textContent).toContain("Hello");
    fireEvent.click(row);
    await waitFor(() =>
      expect(
        overlay.querySelector('[data-patch-highlight="patch-el"]'),
      ).not.toBeNull(),
    );

    const canvas = screen.getByTestId("inpainting-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 1200,
      height: 1600,
      right: 1200,
      bottom: 1600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const transform = () =>
      (document.querySelector('[style*="translate("]') as HTMLElement).style
        .transform;
    const before = transform();
    const drag = (fromX: number, toX: number) => {
      fireEvent.mouseDown(canvas, { clientX: fromX, clientY: 300, button: 0 });
      fireEvent.pointerDown(canvas, {
        clientX: fromX,
        clientY: 300,
        pointerId: 1,
        button: 0,
      });
      fireEvent.pointerMove(canvas, {
        clientX: toX,
        clientY: 300,
        pointerId: 1,
      });
      fireEvent.mouseMove(canvas, { clientX: toX, clientY: 300 });
      fireEvent.pointerUp(canvas, { clientX: toX, clientY: 300, pointerId: 1 });
      fireEvent.mouseUp(canvas, { clientX: toX, clientY: 300 });
    };

    // A brush stroke, then Cancel: nothing is left to apply, and the page never moved.
    const apply = within(panel).getByRole("button", { name: "Apply" });
    const cancel = within(panel).getByRole("button", { name: "Cancel" });
    drag(100, 180);
    await waitFor(() => expect(apply).not.toBeDisabled());
    expect(transform()).toBe(before);
    fireEvent.click(cancel);
    await waitFor(() => expect(apply).toBeDisabled());

    // The eraser over unpainted page is a restore mark, sent as its own job.
    fireEvent.click(within(panel).getByRole("button", { name: "Eraser" }));
    drag(400, 420);
    await waitFor(() => expect(apply).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(apply);
    });
    await waitFor(() =>
      expect(calls("POST", /\/api\/pages\/p1\/manual-cleanup$/)).toHaveLength(
        1,
      ),
    );
    const [, init] = calls("POST", /\/api\/pages\/p1\/manual-cleanup$/)[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.method).toBe("restore");
    expect(body.bounds).toEqual({ x: 400, y: 300, width: 21, height: 1 });
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.stringContaining("Restore queued"),
      "info",
    );
  });
});
