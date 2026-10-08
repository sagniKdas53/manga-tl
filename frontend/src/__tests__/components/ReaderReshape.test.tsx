import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Reader from "../../components/Reader";
import {
  rectToPolygon,
  rotatePoint,
  type Point,
} from "../../utils/polygonUtils";

/**
 * #179 (AUDIT-R13, AUDIT-R14): reshape on a rotated element. The outline is stored in page space
 * and the element is drawn turned about its centre, so the reshape controls must undo that turn,
 * and a vertex drag must measure the outline along the element's own axes.
 */

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useParams: vi.fn(() => ({ pageNumber: "1" })),
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

const user = {
  id: "u1",
  username: "tester",
  email: "t@t.com",
  displayName: "tester",
  role: "translator",
  token: "token123",
};
const series = {
  id: "s1",
  title: "Series",
  coverImageUrl: "",
  readingDirection: "rtl",
  originalLanguage: "ja",
  sourceLanguage: "ja",
  targetLanguage: "en",
  chaptersCount: 1,
  imageId: "img1",
  slug: "series",
};
const chapter = {
  id: "c1",
  seriesId: "s1",
  chapterNumber: 1,
  title: "One",
  status: "COMPLETED",
  pagesCount: 1,
};
const page = {
  id: "p1",
  chapterId: "c1",
  pageNumber: 1,
  imageId: "img1",
  filename: "1.jpg",
  status: "COMPLETED",
  imagePath: "/path",
  processingProgress: 100,
  url: "/api/images/img1/file",
};

// A 120×80 box at 30°, centred on (160, 240), with its outline stored on whole pixels.
const BOX = { x: 100, y: 200, w: 120, h: 80 };
const ANGLE = 30;
const CENTRE: Point = [BOX.x + BOX.w / 2, BOX.y + BOX.h / 2];
const OUTLINE = rectToPolygon(BOX.x, BOX.y, BOX.w, BOX.h, ANGLE).map(
  ([x, y]) => [Math.round(x), Math.round(y)] as Point,
);

const pageDetails = (box: Record<string, unknown> = {}) => ({
  panels: [],
  conversations: [],
  image: { width: 1200, height: 1600 },
  ocrRegions: [],
  layers: [
    {
      layer: {
        id: "layer-tl",
        type: "translation",
        targetLanguage: "en",
        visible: true,
        zOrder: 1,
        createdAt: "2026-10-08T00:00:00Z",
      },
      elements: [
        {
          id: "el-1",
          layerId: "layer-tl",
          regionId: null,
          text: "Tilted",
          font: "Comic Neue",
          size: 16,
          autoSize: true,
          x: BOX.x,
          y: BOX.y,
          maxWidth: BOX.w,
          maxHeight: BOX.h,
          rotation: ANGLE,
          visible: true,
          wordWrap: true,
          backgroundColor: "#ffffff",
          textColor: "#000000",
          fontWeight: "bold",
          fontStyle: "normal",
          isManuallyEdited: false,
          boxShape: "rectangular",
          maskPolygon: JSON.stringify(OUTLINE),
          ...box,
        },
      ],
    },
  ],
});

/** Where an SVG point inside `node` lands on the page, after every `rotate(a, x, y)` above it. */
const onPage = (node: Element, point: Point): Point => {
  let at = point;
  for (let el: Element | null = node; el; el = el.parentElement) {
    const match =
      /rotate\(\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*\)/.exec(
        el.getAttribute("transform") ?? "",
      );
    if (match) {
      at = rotatePoint(
        at,
        [Number(match[2]), Number(match[3])],
        Number(match[1]),
      );
    }
  }
  return at;
};

const puts = () =>
  mockSafeFetch.mock.calls
    .filter(
      ([url, init]) =>
        typeof url === "string" &&
        /\/api\/layer-elements\/el-1$/.test(url) &&
        (init as RequestInit | undefined)?.method === "PUT",
    )
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));

let details = pageDetails();

const enterReshape = async () => {
  render(
    <Reader
      user={user}
      selectedSeries={series}
      selectedChapter={chapter}
      chapters={[chapter]}
      pages={[page]}
      theme="dark"
    />,
  );
  fireEvent.load(await screen.findByAltText(`Page ${page.pageNumber}`));
  const element = await waitFor(() => {
    const found = document.querySelector(
      '.svg-overlay [data-element-id="el-1"]',
    );
    expect(found).not.toBeNull();
    return found!;
  });
  fireEvent.click(element);
  fireEvent.click(await screen.findByRole("button", { name: "Reshape" }));
  return waitFor(() => {
    const handles = document.querySelectorAll(".reshape-vertex-handle");
    expect(handles).toHaveLength(4);
    return [...handles];
  });
};

describe("Reshape on a rotated element (#179)", () => {
  const svgProto = window.SVGSVGElement.prototype as unknown as Record<
    string,
    unknown
  >;
  const saved = {
    createSVGPoint: svgProto.createSVGPoint,
    getScreenCTM: svgProto.getScreenCTM,
    setPointerCapture: Element.prototype.setPointerCapture,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    details = pageDetails();
    // jsdom has no SVG geometry: screen space is page space here.
    svgProto.createSVGPoint = () => ({
      x: 0,
      y: 0,
      matrixTransform(this: { x: number; y: number }) {
        return { x: this.x, y: this.y };
      },
    });
    svgProto.getScreenCTM = () => ({ inverse: () => ({}) });
    Element.prototype.setPointerCapture = vi.fn();
    mockSafeFetch.mockImplementation((url: string) => {
      if (/\/api\/pages\/[^/]+$/.test(url)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(details),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  });

  afterEach(() => {
    svgProto.createSVGPoint = saved.createSVGPoint;
    svgProto.getScreenCTM = saved.getScreenCTM;
    Element.prototype.setPointerCapture = saved.setPointerCapture;
    vi.restoreAllMocks();
  });

  it("draws each vertex handle on the outline, not at twice the angle", async () => {
    const handles = await enterReshape();
    handles.forEach((handle, i) => {
      const [x, y] = onPage(handle, [
        Number(handle.getAttribute("cx")),
        Number(handle.getAttribute("cy")),
      ]);
      expect(x).toBeCloseTo(OUTLINE[i][0], 6);
      expect(y).toBeCloseTo(OUTLINE[i][1], 6);
    });
  });

  it("keeps the box level and its size after a vertex drag, and Undo puts the box back", async () => {
    const handles = await enterReshape();
    // Pull the top-right corner 20 px further along the element's own x axis.
    const [tx, ty] = OUTLINE[1];
    const rad = (ANGLE * Math.PI) / 180;
    const to = {
      clientX: tx + 20 * Math.cos(rad),
      clientY: ty + 20 * Math.sin(rad),
    };
    fireEvent.pointerDown(handles[1], {
      clientX: tx,
      clientY: ty,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, { ...to, pointerId: 1 });
    fireEvent.pointerUp(window, { ...to, pointerId: 1 });

    await waitFor(() => expect(puts().length).toBeGreaterThan(0));
    const dragged = puts().at(-1);
    // 20 px wider along its own axis, the same height, and its centre moved 10 px along that axis.
    expect(Math.abs(dragged.maxWidth - (BOX.w + 20))).toBeLessThanOrEqual(1);
    expect(Math.abs(dragged.maxHeight - BOX.h)).toBeLessThanOrEqual(1);
    const centre = rotatePoint([CENTRE[0] + 10, CENTRE[1]], CENTRE, ANGLE);
    expect(
      Math.abs(dragged.x + dragged.maxWidth / 2 - centre[0]),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(dragged.y + dragged.maxHeight / 2 - centre[1]),
    ).toBeLessThanOrEqual(1);
    expect(dragged.rotation).toBe(ANGLE);

    const before = puts().length;
    await act(async () => {
      fireEvent.click(screen.getByTitle(/^Undo last action/));
    });
    await waitFor(() => expect(puts().length).toBeGreaterThan(before));
    const undone = puts().at(-1);
    expect([undone.x, undone.y, undone.maxWidth, undone.maxHeight]).toEqual([
      BOX.x,
      BOX.y,
      BOX.w,
      BOX.h,
    ]);
    expect(JSON.parse(undone.maskPolygon)).toEqual(OUTLINE);
  });

  it("puts a null box size back as null on Undo, not the 100 px a drag works with", async () => {
    // CodeRabbit on #253: an element with no stored size got 100 written back by Undo.
    details = pageDetails({ maxWidth: null, maxHeight: null });
    const handles = await enterReshape();
    const [tx, ty] = OUTLINE[1];
    fireEvent.pointerDown(handles[1], {
      clientX: tx,
      clientY: ty,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, {
      clientX: tx + 10,
      clientY: ty,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, {
      clientX: tx + 10,
      clientY: ty,
      pointerId: 1,
    });
    await waitFor(() => expect(puts().length).toBeGreaterThan(0));
    const before = puts().length;
    await act(async () => {
      fireEvent.click(screen.getByTitle(/^Undo last action/));
    });
    await waitFor(() => expect(puts().length).toBeGreaterThan(before));
    const undone = puts().at(-1);
    expect(undone.maxWidth ?? null).toBeNull();
    expect(undone.maxHeight ?? null).toBeNull();
    expect([undone.x, undone.y]).toEqual([BOX.x, BOX.y]);
  });
});
