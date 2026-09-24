import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ReaderRightSidebar, {
  type ReaderRightSidebarProps,
} from "../../components/ReaderRightSidebar";
import ReaderTopNav from "../../components/ReaderTopNav";
import { inReadingOrder, regionRowStatus } from "../../utils/regionReview";
import {
  regionIssue,
  regionIssues,
  translationElementByRegion,
} from "../../utils/regionIssues";
import { IssueList, MergePanel } from "../../components/ReaderIssues";
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
    issues: [],
    onSelectIssue: vi.fn(),
    onStepIssue: vi.fn(),
    handleRegionAction: vi.fn(),
    handleSaveIssueTranslation: vi.fn(),
    handleSaveSourceText: vi.fn(),
    isReviewingRegion: false,
    mergeMode: false,
    mergeSelection: [],
    onToggleMergeMode: vi.fn(),
    onToggleMergeRegion: vi.fn(),
    onConfirmMerge: vi.fn(),
    isMerging: false,
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

  it("offers the issue's quick resolutions in the inspector", () => {
    const flagged = region("r1", 4, {
      qaStatus: "cleanup_review",
      qaFeedback: "CTD found no glyphs inside the region.",
    });
    const tl = element("e1", "r1", "Hello", true);
    const issue = regionIssue(flagged, tl, false)!;
    const props = sidebar({
      ocrRegions: [flagged],
      issues: [issue],
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
    expect(
      within(card).getByText("#4 · No lettering found here"),
    ).toBeInTheDocument();
    // The raw detector text is behind "Details", not the headline.
    expect(within(card).queryByText(/CTD found no glyphs/)).toBeNull();
    fireEvent.click(within(card).getByText("Details"));
    expect(within(card).getByText(/CTD found no glyphs/)).toBeInTheDocument();

    fireEvent.click(within(card).getByText("Cover with plain mask"));
    expect(props.handleRegionAction).toHaveBeenCalledWith(flagged, "mask", tl);
    fireEvent.click(within(card).getByText("Keep original"));
    expect(props.handleRegionAction).toHaveBeenCalledWith(
      flagged,
      "reject",
      tl,
    );
    fireEvent.click(within(card).getByText("Delete region"));
    expect(props.handleRegionAction).toHaveBeenCalledWith(
      flagged,
      "delete",
      tl,
    );

    fireEvent.click(within(card).getByText("Type translation"));
    fireEvent.change(within(card).getByLabelText("Translation"), {
      target: { value: "A shop sign" },
    });
    fireEvent.click(within(card).getByText("Save"));
    expect(props.handleSaveIssueTranslation).toHaveBeenCalledWith(
      issue,
      "A shop sign",
    );
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

describe("issues view", () => {
  const tl = (
    id: string,
    regionId: string,
    text: string | null,
    visible = true,
  ) => element(id, regionId, text, visible);

  it("names what is wrong and never counts settled regions", () => {
    const regions = [
      region("a", 3, {
        qaStatus: "manual_review",
        qaFeedback: "Fragment 「あたって」; this bubble is a single sentence.",
      }),
      region("b", 1, { translationFailed: true }),
      region("c", 2),
      region("d", 4, { qaStatus: "rejected" }),
      region("e", 5, { qaStatus: "reject_sfx" }),
      region("f", 6, { qaStatus: "passed" }),
      region("g", 7, { qaStatus: "passed" }),
    ];
    const elements = new Map([
      ["a", tl("ea", "a", "I'd like to")],
      ["b", tl("eb", "b", null, false)],
      ["f", tl("ef", "f", "Too long for its box")],
      ["g", tl("eg", "g", "Fine")],
    ]);
    const issues = regionIssues(regions, elements, new Set(["ef"]));
    expect(issues.map((i) => [i.region.id, i.kind])).toEqual([
      ["b", "failed"],
      ["c", "untranslated"],
      ["a", "qa"],
      ["f", "overflow"],
    ]);
    expect(issues[2].hint).toMatch(/Merge regions/);
    expect(issues[3].actions).toEqual(["fit", "edit", "mask"]);
    // A plate needs text over it to be drawn, so an untranslated region is not offered one.
    expect(issues[1].actions).not.toContain("mask");
  });

  it("corrects the source text of a flagged region", () => {
    const flagged = region("r1", 2, { qaStatus: "manual_review" });
    const issue = regionIssue(flagged, element("e1", "r1", "Hi", true), false)!;
    const props = sidebar({
      ocrRegions: [flagged],
      issues: [issue],
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
    fireEvent.click(within(card).getByText("Type source text"));
    const field = within(card).getByLabelText("Source text");
    expect(field).toHaveValue("source 2");
    fireEvent.change(field, { target: { value: "正しい文" } });
    fireEvent.click(within(card).getByText("Save"));
    expect(props.handleSaveSourceText).toHaveBeenCalledWith(issue, "正しい文");
  });

  it("offers the plain mask on a region nothing flagged", () => {
    const fine = region("r1", 1, { qaStatus: "passed" });
    const tlLayer = {
      id: "tl",
      type: "translation",
      visible: true,
      zOrder: 2,
    } as unknown as Layer;
    const drawn = element("e1", "r1", "Hello", true);
    const props = sidebar({
      ocrRegions: [fine],
      layers: [{ layer: tlLayer, elements: [drawn] }],
      selectedItem: {
        id: "region-r1",
        isConversation: false,
        regions: [fine],
        bboxX: 0,
        bboxY: 0,
        bboxW: 10,
        bboxH: 10,
      },
    });
    fireEvent.click(screen.getByText("Cover with plain mask"));
    expect(props.handleRegionAction).toHaveBeenCalledWith(fine, "mask", drawn);
  });

  it("resolves each region to the element that is drawn", () => {
    const layer = (id: string, zOrder: number, visible: boolean) =>
      ({ id, type: "translation", visible, zOrder }) as unknown as Layer;
    const map = translationElementByRegion([
      { layer: layer("base", 1, true), elements: [tl("old", "r", "old")] },
      { layer: layer("redo", 2, true), elements: [tl("new", "r", "new")] },
      { layer: layer("hidden", 3, false), elements: [tl("gone", "r", "gone")] },
    ]);
    expect(map.get("r")?.id).toBe("new");
  });

  it("lists issues and opens one on click", () => {
    const onSelect = vi.fn();
    const issue = regionIssue(region("a", 2), undefined, false)!;
    render(
      <IssueList
        issues={[issue]}
        selectedRegionId={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText("Not translated"));
    expect(onSelect).toHaveBeenCalledWith(issue);
  });

  it("merges only once two pieces are picked", () => {
    const onToggle = vi.fn();
    const onMerge = vi.fn();
    const regions = [region("a", 4), region("b", 5), region("c", 6)];
    const { rerender } = render(
      <MergePanel
        regions={regions}
        selected={["a"]}
        busy={false}
        onToggle={onToggle}
        onMerge={onMerge}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Region 5"));
    expect(onToggle).toHaveBeenCalledWith("b");
    rerender(
      <MergePanel
        regions={regions}
        selected={["a", "b"]}
        busy={false}
        onToggle={onToggle}
        onMerge={onMerge}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Merge #4 #5" }));
    expect(onMerge).toHaveBeenCalledOnce();
  });
});
