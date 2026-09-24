import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ReaderRightSidebar, {
  type ReaderRightSidebarProps,
} from "../../components/ReaderRightSidebar";
import ReaderTopNav from "../../components/ReaderTopNav";
import { inReadingOrder, regionRowStatus } from "../../utils/regionReview";
import type { Layer, LayerElement, OcrRegion } from "../../types";

const region = (id: string, order: number, extra: Partial<OcrRegion> = {}) =>
  ({
    id,
    text: `source ${order}`,
    bubbleReadingOrder: order,
    bboxX: 0,
    bboxY: 0,
    bboxW: 10,
    bboxH: 10,
    detectedLanguage: "ja",
    ...extra,
  }) as unknown as OcrRegion;

const element = (
  id: string,
  regionId: string,
  text: string | null,
  visible: boolean,
) =>
  ({
    id,
    regionId,
    text,
    visible,
    x: 0,
    y: 0,
    maxWidth: 10,
    maxHeight: 10,
  }) as unknown as LayerElement;

function sidebar(overrides: Partial<ReaderRightSidebarProps>) {
  const props = {
    selectedItem: null,
    setSelectedItem: vi.fn(),
    activeLayerId: null,
    setActiveLayerId: vi.fn(),
    sortedLayers: [],
    layers: [],
    manuallyShownOcrLayers: new Set<string>(),
    cleanScanlationView: false,
    handleMoveLayer: vi.fn(),
    handleCreateTranslationLayer: vi.fn(),
    handleCreateSfxLayer: vi.fn(),
    handleToggleLayerVisibility: vi.fn(),
    handleCloneLayer: vi.fn(),
    handleDeleteLayer: vi.fn(),
    handleAddNewElement: vi.fn(),
    handleLaunchEyeDropper: vi.fn(),
    handleRedoPageOcr: vi.fn(),
    isRedoingPageOcr: false,
    handleRedoPageTranslation: vi.fn(),
    isRedoingPageTranslation: false,
    handleExportPng: vi.fn(),
    handleExportZip: vi.fn(),
    interactionMode: "none",
    setInteractionMode: vi.fn(),
    undoStack: [],
    handleUndo: vi.fn(),
    handleEnterReshapeMode: vi.fn(),
    handleUpdateSelectedElement: vi.fn(),
    dirtyElements: new Set<string>(),
    handleSaveElementChanges: vi.fn(),
    handleSetElementVisibility: vi.fn(),
    handleDeleteElement: vi.fn(),
    ocrRegions: [],
    isRedoingRegionOcr: false,
    handleRedoRegion: vi.fn(),
    isRedoingRegionTl: false,
    handleReviewRegion: vi.fn(),
    isReviewingRegion: false,
    ...overrides,
  } as ReaderRightSidebarProps;
  render(<ReaderRightSidebar {...props} />);
  return props;
}

describe("region review helpers", () => {
  it("orders elements by their region's reading order", () => {
    const regions = new Map([
      ["a", region("a", 2)],
      ["b", region("b", 1)],
    ]);
    const sorted = inReadingOrder(
      [element("e1", "a", "x", true), element("e2", "b", "y", true)],
      regions,
    );
    expect(sorted.map((e) => e.id)).toEqual(["e2", "e1"]);
  });

  it("names why a row is not drawn", () => {
    const hidden = (text: string | null) => element("e", "r", text, false);
    expect(
      regionRowStatus(region("r", 1, { qaStatus: "rejected" }), hidden("x")),
    ).toEqual({ label: "Rejected", tone: "muted" });
    expect(
      regionRowStatus(region("r", 1, { qaStatus: "reject_sfx" }), hidden("x")),
    ).toEqual({ label: "SFX", tone: "muted" });
    expect(
      regionRowStatus(
        region("r", 1, { translationFailed: true }),
        hidden(null),
      ),
    ).toEqual({ label: "Failed", tone: "warning" });
    expect(regionRowStatus(region("r", 1), hidden(null))).toEqual({
      label: "Not translated",
      tone: "muted",
    });
    expect(
      regionRowStatus(
        region("r", 1, { qaStatus: "cleanup_review" }),
        element("e", "r", "Hello", true),
      ),
    ).toEqual({ label: "Review", tone: "warning" });
    expect(
      regionRowStatus(region("r", 1), element("e", "r", "Hello", true)),
    ).toBeNull();
  });
});

describe("Reader review UI", () => {
  it("lists every region, numbered in reading order, with reasons", () => {
    const regions = [
      region("r1", 1, { qaStatus: "rejected" }),
      region("r2", 2),
      region("r3", 3, { qaStatus: "reject_sfx" }),
    ];
    const layer = {
      id: "tl",
      type: "translation",
      visible: true,
      zOrder: 2,
      metadataJson: {},
    } as unknown as Layer;
    const elements = [
      element("e3", "r3", "Bang", false),
      element("e2", "r2", "Hello", true),
      element("e1", "r1", null, false),
    ];
    sidebar({
      ocrRegions: regions,
      sortedLayers: [{ layer, elements }],
      layers: [{ layer, elements }],
      activeLayerId: "tl",
    });
    fireEvent.click(screen.getByText(/3 elements/));

    const rows = screen.getAllByText(/^#\d$/).map((n) => n.textContent);
    expect(rows).toEqual(["#1", "#2", "#3"]);
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    const sfxRow = screen.getByText("Bang").parentElement as HTMLElement;
    expect(within(sfxRow).getByText("SFX")).toBeInTheDocument();
    // A row with no translation still shows what OCR read there.
    expect(screen.getByText("source 1")).toBeInTheDocument();
  });

  it("offers Reject and Delete for a flagged region", () => {
    const flagged = region("r1", 4, {
      qaStatus: "cleanup_review",
      qaFeedback: "Rejected by nobody yet: a faded sign.",
    });
    const props = sidebar({
      ocrRegions: [flagged],
      selectedItem: {
        id: "region-r1",
        isConversation: false,
        regions: [flagged],
        bboxX: 0,
        bboxY: 0,
        bboxW: 10,
        bboxH: 10,
      },
    });
    const card = screen.getByRole("status");
    expect(within(card).getByText("Needs review")).toBeInTheDocument();
    expect(within(card).getByText(/a faded sign/)).toBeInTheDocument();

    fireEvent.click(within(card).getByText("Reject — leave as is"));
    expect(props.handleReviewRegion).toHaveBeenCalledWith(flagged, "reject");
    fireEvent.click(within(card).getByText("Delete region"));
    expect(props.handleReviewRegion).toHaveBeenCalledWith(flagged, "delete");
  });

  it("shows a review chip in the top bar only when something needs a look", () => {
    const onReviewClick = vi.fn();
    const { rerender } = render(
      <ReaderTopNav
        title="t"
        onBack={vi.fn()}
        onToggleLeftSidebar={vi.fn()}
        onToggleRightSidebar={vi.fn()}
        reviewCount={0}
        onReviewClick={onReviewClick}
      />,
    );
    expect(screen.queryByText(/to review/)).toBeNull();
    rerender(
      <ReaderTopNav
        title="t"
        onBack={vi.fn()}
        onToggleLeftSidebar={vi.fn()}
        onToggleRightSidebar={vi.fn()}
        reviewCount={2}
        onReviewClick={onReviewClick}
      />,
    );
    fireEvent.click(screen.getByText("2 to review"));
    expect(onReviewClick).toHaveBeenCalledOnce();
  });
});
