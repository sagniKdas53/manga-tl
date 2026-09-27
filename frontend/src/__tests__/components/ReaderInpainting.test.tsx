import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Reader from "../../components/Reader";

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
});
