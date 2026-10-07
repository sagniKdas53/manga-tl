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
  const view = render(
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
  return view;
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

  it("draws a region's OCR pieces only with Show debug and OCR fragments on, never over the reading views (#243)", async () => {
    const quad = (x: number) => [
      [x, 60],
      [x + 50, 60],
      [x + 50, 140],
      [x, 140],
    ];
    const base = mockSafeFetch.getMockImplementation()!;
    mockSafeFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (/\/api\/pages\/[^/]+$/.test(url)) {
        const details = pageDetails();
        Object.assign(details.ocrRegions[0], {
          ownershipProvenance: {
            fragments: [0, 1].map((index) => ({
              index,
              provenance: {
                sourceQuad: quad(50 + index * 60),
                geometry: { majorAxisDegrees: 90 },
                ownerDecision: {
                  state: "assigned",
                  reason: "validated-container-continuous-lines",
                },
              },
            })),
          },
        });
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(details),
        });
      }
      return base(url, init);
    });
    const pieces = () =>
      document.querySelectorAll('.svg-overlay [data-ocr-fragment="r1"]');
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    try {
      localStorage.setItem("manga_clean_view", "false");
      localStorage.setItem("manga_show_ocr", "true");
      localStorage.setItem("manga_show_ocr_fragments", "true");
      await renderReader();
      await waitFor(() => expect(pieces()).toHaveLength(2));
      expect(pieces()[1].getAttribute("points")).toBe(
        "110,60 160,60 160,140 110,140",
      );
      expect(pieces()[0].querySelector("title")?.textContent).toBe(
        "OCR piece 1 of 2\nvalidated-container-continuous-lines (assigned)\n90°",
      );
      // Above the text layers, so a piece under English can still be hovered: its band comes
      // after every element's hit box, and only the band takes the pointer.
      const handles = document.querySelectorAll(
        ".svg-overlay .element-drag-handle",
      );
      expect(handles.length).toBeGreaterThan(0);
      expect(
        handles[handles.length - 1].compareDocumentPosition(pieces()[0]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect((pieces()[0] as SVGElement).style.pointerEvents).toBe("stroke");
      cleanup();

      for (const [debug, fragments, clean] of [
        ["true", "false", "false"],
        ["false", "true", "false"],
        ["true", "true", "true"],
      ]) {
        localStorage.setItem("manga_show_ocr", debug);
        localStorage.setItem("manga_show_ocr_fragments", fragments);
        localStorage.setItem("manga_clean_view", clean);
        await renderReader();
        await act(settle);
        expect(pieces()).toHaveLength(0);
        cleanup();
      }
    } finally {
      localStorage.removeItem("manga_show_ocr");
      localStorage.removeItem("manga_show_ocr_fragments");
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

  // 2026-10-01: the export draws every text with a halo in its background colour; the editor drew
  // none, so the canvas and the download disagreed on every outlined line.
  it("outlines the text in its background colour, every halo under every fill, as the export does", async () => {
    await renderReader();
    const overlay = document.querySelector(".svg-overlay")!;
    await waitFor(() => expect(overlay.textContent).toContain("Hello"));
    const passes = [
      ...overlay.querySelectorAll<HTMLElement>("[data-text-pass]"),
    ].filter((el) => el.textContent?.includes("Hello"));
    const strokes = passes.filter((el) => el.dataset.textPass === "stroke");
    const fills = passes.filter((el) => el.dataset.textPass === "fill");
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes.length).toBe(fills.length);
    for (const stroke of strokes) {
      expect(stroke.getAttribute("style")).toMatch(
        /-webkit-text-stroke: [\d.]+px #ffffff/,
      );
      expect(stroke.style.color).toBe("transparent");
      // Halos first: each lies before every fill in the box it belongs to.
      const box = stroke.parentElement!;
      const firstFill = [...box.children].findIndex(
        (el) => (el as HTMLElement).dataset.textPass === "fill",
      );
      expect([...box.children].indexOf(stroke)).toBeLessThan(firstFill);
    }
  });

  it("draws no flat plate under any region's text, patched or not", async () => {
    // User review 2026-10-02 (page 21): the plate was the "old type mask" on SFX before QA.
    await renderReader();
    expect(document.querySelectorAll(".svg-overlay polygon")).toHaveLength(0);
    expect(
      document.querySelector('.svg-overlay [data-element-id="el-2"]'),
    ).not.toBeNull();
  });

  it("hides a sound effect that has no patch, and shows one typed by hand", async () => {
    // As the export: cleanup leaves SFX alone, so until QA keeps one and its late patch lands,
    // the artist's lettering shows.
    const base = mockSafeFetch.getMockImplementation()!;
    let handTyped = false;
    mockSafeFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (/\/api\/pages\/[^/]+$/.test(url)) {
        const details = pageDetails();
        Object.assign(details.ocrRegions[1], { regionType: "sfx" });
        details.layers[0].elements[1] = {
          ...details.layers[0].elements[1],
          isManuallyEdited: handTyped,
        };
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(details),
        });
      }
      return base(url, init);
    });
    const { unmount } = await renderReader();
    expect(
      document.querySelector('.svg-overlay [data-element-id="el-2"]'),
    ).toBeNull();
    expect(
      document.querySelector('.svg-overlay [data-element-id="el-1"]'),
    ).not.toBeNull();
    unmount();

    handTyped = true;
    await renderReader();
    expect(
      document.querySelector('.svg-overlay [data-element-id="el-2"]'),
    ).not.toBeNull();
  });

  it("saves an element's pending edit when it is deselected", async () => {
    // User review 2026-10-02 (page 30): after Deselect the edit sat unsaved until Export asked.
    await renderReader();
    fireEvent.click(
      document.querySelector('.svg-overlay [data-element-id="el-2"]')!,
    );
    fireEvent.change(await screen.findByLabelText("Text Content"), {
      target: { value: "Hey there" },
    });
    expect(calls("PUT", /\/api\/layer-elements\/el-2$/)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Deselect" }));
    await waitFor(() =>
      expect(calls("PUT", /\/api\/layer-elements\/el-2$/)).toHaveLength(1),
    );
    await waitFor(() =>
      expect(calls("POST", /\/api\/pages\/p1\/render$/)).toHaveLength(1),
    );
  });

  it("draws nothing for a region whose translation QA emptied, as the export does", async () => {
    // User review 2026-10-02 (page 12): QA emptied an SFX's text, and the editor still drew the
    // region's plate, a blank white box on the art. The export already skipped it.
    const base = mockSafeFetch.getMockImplementation()!;
    mockSafeFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (/\/api\/pages\/[^/]+$/.test(url)) {
        const details = pageDetails();
        details.layers[0].elements[1] = {
          ...details.layers[0].elements[1],
          text: "",
        };
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(details),
        });
      }
      return base(url, init);
    });
    await renderReader();
    expect(document.querySelectorAll(".svg-overlay polygon")).toHaveLength(0);
  });

  it("outlines a review region clicked on the page with Show debug off", async () => {
    // User review 2026-10-02 (page 16): with the debug boxes off there was nothing to click, and
    // a region opened from the Issues list was not shown on the page.
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
    try {
      localStorage.setItem("manga_show_ocr", "false");
      localStorage.setItem("manga_clean_view", "false");
      await renderReader();
      expect(document.querySelector("[data-review-selected]")).toBeNull();
      const hit = document.querySelector('[data-review-region="r2"]')!;
      expect(hit.getAttribute("fill")).toBe("transparent");
      fireEvent.click(hit);
      await waitFor(() =>
        expect(
          document.querySelector('[data-review-selected="r2"]'),
        ).not.toBeNull(),
      );
    } finally {
      localStorage.removeItem("manga_show_ocr");
      localStorage.removeItem("manga_clean_view");
    }
  });

  it("saves an edit when asked or after 30 s idle, not 1.5 s later, then renders the page", async () => {
    // User review 2026-10-02: each change was saved 1.5 s after it, so one session advanced a
    // page's revision twenty times, and the render waited for the debounce and a worker.
    await renderReader();
    fireEvent.click(
      document.querySelector('.svg-overlay [data-element-id="el-2"]')!,
    );
    const field = await screen.findByLabelText("Text Content");
    fireEvent.change(field, { target: { value: "Hey there" } });
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(calls("PUT", /\/api\/layer-elements\/el-2$/)).toHaveLength(0);

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(calls("PUT", /\/api\/layer-elements\/el-2$/)).toHaveLength(1),
    );
    const [, init] = calls("PUT", /\/api\/layer-elements\/el-2$/)[0];
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      text: "Hey there",
    });
    await waitFor(() =>
      expect(calls("POST", /\/api\/pages\/p1\/render$/)).toHaveLength(1),
    );
  });

  it("renders the page after a layer is hidden or a patch deleted, not only on Export", async () => {
    // User review 2026-10-02: only element saves asked for a render; mask changes waited for Export.
    await renderReader();
    fireEvent.click(screen.getAllByRole("button", { name: "Hide layer" })[0]);
    await waitFor(() =>
      expect(calls("POST", /\/api\/pages\/p1\/render$/)).toHaveLength(1),
    );

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
      expect(calls("POST", /\/api\/pages\/p1\/render$/)).toHaveLength(2),
    );
  });

  it("keeps an edit whose save failed pending, and saves it on the next flush", async () => {
    const base = mockSafeFetch.getMockImplementation()!;
    let puts = 0;
    mockSafeFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (/\/api\/layer-elements\/el-2$/.test(url) && init?.method === "PUT") {
        puts += 1;
        return Promise.resolve({
          ok: puts > 1,
          json: () => Promise.resolve({}),
        });
      }
      return base(url, init);
    });
    await renderReader();
    fireEvent.click(
      document.querySelector('.svg-overlay [data-element-id="el-2"]')!,
    );
    fireEvent.change(await screen.findByLabelText("Text Content"), {
      target: { value: "Hey there" },
    });

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(puts).toBe(1));
    expect(calls("POST", /\/api\/pages\/p1\/render$/)).toHaveLength(0);

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(puts).toBe(2));
    await waitFor(() =>
      expect(calls("POST", /\/api\/pages\/p1\/render$/)).toHaveLength(1),
    );
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
    // The text is untouched, and no flat plate comes back in the patch's place.
    expect(
      document.querySelector('.svg-overlay [data-element-id="el-1"]'),
    ).not.toBeNull();
    expect(document.querySelectorAll(".svg-overlay polygon")).toHaveLength(0);

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

  it("hides a region's patch with its text, as one undo step that saves both, then renders once (#237)", async () => {
    await renderReader();
    const renders = () => calls("POST", /\/api\/pages\/p1\/render$/).length;
    const body = (id: string) =>
      JSON.parse(
        (
          calls("PUT", new RegExp(`/api/layer-elements/${id}$`)).at(
            -1,
          )![1] as RequestInit
        ).body as string,
      );
    fireEvent.click(screen.getByText(/3 elements/));
    fireEvent.click(screen.getAllByLabelText("Hide element")[0]);

    await waitFor(() =>
      expect(
        document.querySelector('[data-cleanup-id="cleanup-patch-el"]'),
      ).toBeNull(),
    );
    await waitFor(() => expect(renders()).toBe(1));
    expect(body("el-1")).toMatchObject({ visible: false });
    expect(body("patch-el")).toMatchObject({
      visible: false,
      hiddenWithText: true,
    });
    // The region's other neighbours are untouched.
    expect(calls("PUT", /\/api\/layer-elements\/el-2$/)).toHaveLength(0);

    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-cleanup-id="cleanup-patch-el"]'),
      ).not.toBeNull(),
    );
    expect(body("el-1")).toMatchObject({ visible: true });
    expect(body("patch-el")).toMatchObject({
      visible: true,
      hiddenWithText: false,
    });
    await waitFor(() => expect(renders()).toBe(2));

    await act(async () => {
      fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-cleanup-id="cleanup-patch-el"]'),
      ).toBeNull(),
    );
    expect(body("patch-el")).toMatchObject({
      visible: false,
      hiddenWithText: true,
    });
    await waitFor(() => expect(renders()).toBe(3));
  });

  it("leaves a patch hidden by itself hidden when its text is shown again (#237)", async () => {
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
    const patchSaves = () =>
      calls("PUT", /\/api\/layer-elements\/patch-el$/).length;
    expect(patchSaves()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Deselect" }));

    fireEvent.click(screen.getByText(/3 elements/));
    fireEvent.click(screen.getAllByLabelText("Hide element")[0]);
    await waitFor(() =>
      expect(calls("PUT", /\/api\/layer-elements\/el-1$/)).toHaveLength(1),
    );
    fireEvent.click(screen.getByLabelText("Show element"));
    await waitFor(() =>
      expect(calls("PUT", /\/api\/layer-elements\/el-1$/)).toHaveLength(2),
    );
    expect(patchSaves()).toBe(1);
    expect(
      document.querySelector('[data-cleanup-id="cleanup-patch-el"]'),
    ).toBeNull();
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
          putImageData: (image: ImageData, dx: number, dy: number) => {
            const marked = marksOf(canvas);
            for (let i = 3; i < image.data.length; i += 4) {
              if (!image.data[i]) continue;
              const pixel = (i - 3) / 4;
              marked.add(
                `${dx + (pixel % image.width)},${dy + Math.floor(pixel / image.width)}`,
              );
            }
          },
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

  it("keeps the brush ring on the pointer, and the paint under it, when the page is zoomed", async () => {
    // User review 2026-10-02: at 220 % the ring sat zoom× further from the page's corner than the
    // pointer, so the paint landed up and left of where the user aimed.
    await renderReader();
    await act(async () => {
      fireEvent.click(screen.getByText("Inpainting"));
    });
    await screen.findByRole("toolbar", { name: "Inpainting tools" });
    const canvas = screen.getByTestId("inpainting-canvas");
    // Zoomed 2×: 1200 CSS pixels wide on its own, 2400 on screen.
    Object.defineProperty(canvas, "offsetWidth", { value: 1200 });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      width: 2400,
      height: 3200,
      right: 2500,
      bottom: 3250,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });
    fireEvent.pointerMove(canvas, { clientX: 500, clientY: 850, pointerId: 1 });
    const ring = canvas.querySelector<HTMLDivElement>(
      "div[style*='border-radius']",
    )!;
    const size = parseFloat(ring.style.width);
    // Page pixel (200, 400) is CSS pixel (200, 400) inside the zoomed box.
    expect(parseFloat(ring.style.left) + size / 2).toBeCloseTo(200);
    expect(parseFloat(ring.style.top) + size / 2).toBeCloseTo(400);

    fireEvent.pointerDown(canvas, { clientX: 500, clientY: 850, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 500, clientY: 850, pointerId: 1 });
    expect(marksOf(screen.getByTestId("inpainting-paint")).has("200,400")).toBe(
      true,
    );
  });

  it("pans the page with a drag and keeps it there once the drag ends", async () => {
    await renderReader();
    await waitFor(() =>
      expect(document.querySelector(".svg-overlay")!.textContent).toContain(
        "Hello",
      ),
    );
    const area = document.querySelector(".reader-canvas-area") as HTMLElement;
    const wrapper = document.querySelector(
      ".manga-canvas-wrapper",
    ) as HTMLElement;
    expect(wrapper.style.transform).toContain("translate(0px, 0px)");

    await act(async () => {
      fireEvent.mouseDown(area, { clientX: 100, clientY: 100, button: 0 });
    });
    // The page follows the pointer by a direct style write, one per frame, not a re-render.
    await act(async () => {
      fireEvent.mouseMove(area, { clientX: 160, clientY: 130 });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(wrapper.style.transform).toContain("translate(60px, 30px)");

    await act(async () => {
      fireEvent.mouseUp(area, { clientX: 160, clientY: 130 });
    });
    expect(wrapper.style.transform).toContain("translate(60px, 30px)");
  });

  it("keeps a one-finger pan when a second finger starts a pinch", async () => {
    // Reader.tsx treats the device as a touch screen when `ontouchstart` exists.
    (window as unknown as { ontouchstart: null }).ontouchstart = null;
    try {
      await renderReader();
      await waitFor(() =>
        expect(document.querySelector(".svg-overlay")!.textContent).toContain(
          "Hello",
        ),
      );
      const area = document.querySelector(".reader-canvas-area") as HTMLElement;
      const wrapper = document.querySelector(
        ".manga-canvas-wrapper",
      ) as HTMLElement;
      const touch = (x: number, y: number) => ({ clientX: x, clientY: y });

      await act(async () => {
        fireEvent.touchStart(area, { touches: [touch(100, 100)] });
      });
      await act(async () => {
        fireEvent.touchMove(area, { touches: [touch(160, 130)] });
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(wrapper.style.transform).toContain("translate(60px, 30px)");

      // A second finger lands and the pinch zooms: the page stays where the drag left it.
      await act(async () => {
        fireEvent.touchStart(area, {
          touches: [touch(160, 130), touch(260, 130)],
        });
      });
      await act(async () => {
        fireEvent.touchMove(area, {
          touches: [touch(140, 130), touch(290, 130)],
        });
      });
      expect(wrapper.style.transform).toContain("translate(60px, 30px)");
      expect(wrapper.style.transform).not.toContain("scale(1)");

      await act(async () => {
        fireEvent.touchEnd(area, { touches: [] });
      });
      expect(wrapper.style.transform).toContain("translate(60px, 30px)");
    } finally {
      delete (window as unknown as { ontouchstart?: null }).ontouchstart;
    }
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
    fireEvent.click(within(panel).getByRole("button", { name: "Erase" }));
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

  // CodeRabbit on #152: Apply posts the repaint, then the restore. When only the restore fails,
  // a retry used to queue the repaint a second time, landing a duplicate Inpainting layer.
  it("follows the sidebar toggle, and keeps the marks while hidden", async () => {
    // User review 2026-10-02: the panel stayed when the inspector was toggled off.
    await renderReader();
    await act(async () => {
      fireEvent.click(screen.getByText("Inpainting"));
    });
    await screen.findByRole("toolbar", { name: "Inpainting tools" });
    expect(screen.getByRole("button", { name: "Draw" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Erase" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide Inspector" }));
    await waitFor(() =>
      expect(screen.queryByTestId("inpainting-panel-host")).toBeNull(),
    );
    expect(screen.getByTestId("inpainting-canvas")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show Inspector" }));
    await screen.findByRole("toolbar", { name: "Inpainting tools" });
  });

  it("retries only the restore when the repaint was queued and the restore failed", async () => {
    await renderReader();
    const overlay = document.querySelector(".svg-overlay")!;
    await waitFor(() => expect(overlay.textContent).toContain("Hello"));
    await act(async () => {
      fireEvent.click(screen.getByText("Inpainting"));
    });
    const panel = await screen.findByRole("toolbar", {
      name: "Inpainting tools",
    });
    const fallback = mockSafeFetch.getMockImplementation()!;
    let posts = 0;
    mockSafeFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (/manual-cleanup$/.test(url) && init?.method === "POST") {
        posts += 1;
        if (posts === 2) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("storage down"),
          });
        }
      }
      return fallback(url, init);
    });
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
    const stroke = (fromX: number, toX: number) => {
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
      fireEvent.pointerUp(canvas, { clientX: toX, clientY: 300, pointerId: 1 });
    };
    stroke(100, 120); // repaint
    fireEvent.click(within(panel).getByRole("button", { name: "Erase" }));
    stroke(400, 420); // restore
    const apply = within(panel).getByRole("button", { name: "Apply" });
    await waitFor(() => expect(apply).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(apply);
    });
    await waitFor(() => expect(posts).toBe(2));
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.stringContaining("Repaint queued; the restore failed"),
      "error",
    );
    // The retry: only the restore goes, and only once.
    await waitFor(() => expect(apply).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(apply);
    });
    await waitFor(() => expect(posts).toBe(3));
    const sent = calls("POST", /\/api\/pages\/p1\/manual-cleanup$/).map(
      ([, init]) => JSON.parse((init as RequestInit).body as string).method,
    );
    expect(sent).toEqual(["auto", "restore", "restore"]);
  });

  // 2026-10-01 video: dragging the Size slider moved the page by the drag's width. The panel is a
  // React portal, so its mouse events bubbled to the canvas's pan handlers through the React tree.
  it("never pans when a drag starts in the panel, and pans with the Pan tool", async () => {
    await renderReader();
    const overlay = document.querySelector(".svg-overlay")!;
    await waitFor(() => expect(overlay.textContent).toContain("Hello"));
    await act(async () => {
      fireEvent.click(screen.getByText("Inpainting"));
    });
    const panel = await screen.findByRole("toolbar", {
      name: "Inpainting tools",
    });
    const transform = () =>
      (document.querySelector('[style*="translate("]') as HTMLElement).style
        .transform;
    const before = transform();

    const slider = within(panel).getByRole("slider", { name: "Brush size" });
    fireEvent.mouseDown(slider, { clientX: 100, clientY: 50, button: 0 });
    fireEvent.mouseMove(slider, { clientX: 240, clientY: 50 });
    fireEvent.mouseUp(slider, { clientX: 240, clientY: 50 });
    expect(transform()).toBe(before);

    // The Pan tool: a drag on the page moves it and leaves no mark.
    fireEvent.click(within(panel).getByRole("button", { name: "Pan" }));
    const canvas = screen.getByTestId("inpainting-canvas");
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 300, button: 0 });
    fireEvent.pointerDown(canvas, {
      clientX: 100,
      clientY: 300,
      pointerId: 1,
      button: 0,
    });
    fireEvent.pointerMove(canvas, { clientX: 180, clientY: 300, pointerId: 1 });
    fireEvent.mouseMove(canvas, { clientX: 180, clientY: 300 });
    fireEvent.pointerUp(canvas, { clientX: 180, clientY: 300, pointerId: 1 });
    fireEvent.mouseUp(canvas, { clientX: 180, clientY: 300 });
    expect(transform()).not.toBe(before);
    expect(transform()).toContain("translate(80px, 0px)");
    expect(within(panel).getByRole("button", { name: "Apply" })).toBeDisabled();
  });
});
