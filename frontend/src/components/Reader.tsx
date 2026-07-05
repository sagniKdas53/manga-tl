import React, { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type {
  User,
  Chapter,
  Page,
  Panel,
  OcrRegion,
  Conversation,
  Layer,
  LayerElement,
  Series,
} from "../types";
import { safeFetch, toSlug } from "../utils";
import { fitTextInBox } from "../utils/fitText";
import ConfirmModal from "./ConfirmModal";
import InfoModal from "./InfoModal";
import { ColorPicker } from "./ColorPicker";
import { useNotifications } from "./useNotifications";
import { useToast } from "./ToastContext";
import JSZip from "jszip";
import {
  type Point,
  type Polygon,
  polygonBBox,
  polygonCentroid,
  rectToPolygon,
  ellipseToPolygon,
  rotatePolygon,
  translatePolygon,
  isVertexMoveValid,
  isRotationValid,
} from "../utils/polygonUtils";

interface ReaderProps {
  user: User;
  selectedSeries: Series | null;
  selectedChapter: Chapter | null;
  chapters: Chapter[];
  pages: Page[];
  theme: "light" | "dark";
}

/** A single renderable item in the reader — either a conversation group or a standalone region. */
interface RenderItem {
  id: string;
  isConversation: boolean;
  regions: OcrRegion[];
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  approved: boolean;
  sceneType: string;
  /** Only present for standalone regions */
  originalRegion?: OcrRegion;
  /** Only present for conversation items */
  conversationData?: Conversation & {
    regions: OcrRegion[];
    bboxX: number;
    bboxY: number;
    bboxW: number;
    bboxH: number;
    approved: boolean;
  };
  /** Set when item is a layer element */
  isLayerElement?: boolean;
}

type SelectedItemType =
  (RenderItem & LayerElement) | RenderItem | LayerElement | null;

async function saveElementChanges(
  element: LayerElement,
  showAlert: boolean = true,
  token: string,
  showToast: (
    message: string,
    type?: "success" | "error" | "info" | "warning",
  ) => void,
  showError: (
    message: string,
    options?: { action?: { label: string; onClick: () => void } },
  ) => void,
) {
  try {
    const res = await safeFetch(`/api/layer-elements/${element.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        text: element.text,
        font: element.font,
        size: element.size,
        autoSize: element.autoSize,
        maxWidth: element.maxWidth,
        maxHeight: element.maxHeight,
        wordWrap: element.wordWrap,
        rotation: element.rotation,
        x: element.x,
        y: element.y,
        visible: element.visible,
        overflow: element.overflow,
        backgroundColor: element.backgroundColor,
        textColor: element.textColor,
        fontWeight: element.fontWeight || "normal",
        fontStyle: element.fontStyle || "normal",
        boxShape: element.boxShape,
        maskPolygon: element.maskPolygon,
      }),
    });

    if (!res.ok) {
      throw new Error("Failed to update element on server");
    }

    if (showAlert) {
      showToast("Element updated successfully!", "success");
    }
  } catch (err) {
    console.error(err);
    showError("Error updating element on server.", {
      action: {
        label: "Retry",
        onClick: () =>
          saveElementChanges(element, showAlert, token, showToast, showError),
      },
    });
  }
}

export const Reader: React.FC<ReaderProps> = ({
  user,
  selectedSeries,
  selectedChapter,
  chapters,
  pages,
  theme,
}) => {
  const navigate = useNavigate();
  const { pageNumber } = useParams<{ pageNumber: string }>();

  // Suppress unused warning for theme prop
  if (theme) {
    // theme-dependent checks
  }

  // Find selected page based on route param
  const curPageNum = parseInt(pageNumber || "1");
  const totalPages = pages.length;
  const selectedPage = pages.find((p) => p.pageNumber === curPageNum);

  // Reader States
  const [panels, setPanels] = useState<Panel[]>([]);
  const [ocrRegions, setOcrRegions] = useState<OcrRegion[]>([]);
  const [imageDims, setImageDims] = useState({ w: 800, h: 1200 });
  const [showPanels, setShowPanels] = useState(() => {
    const saved = localStorage.getItem("manga_show_panels");
    return saved === null ? true : saved === "true";
  });
  const [showOcr, setShowOcr] = useState(() => {
    const saved = localStorage.getItem("manga_show_ocr");
    return saved === null ? true : saved === "true";
  });
  const [showTranslations] = useState(false);
  const [showLeftSidebar, setShowLeftSidebar] = useState(() => {
    const saved = localStorage.getItem("manga_show_left_sidebar");
    return saved === null ? true : saved === "true";
  });
  const [showRightSidebar, setShowRightSidebar] = useState(() => {
    const saved = localStorage.getItem("manga_show_right_sidebar");
    return saved === null ? true : saved === "true";
  });
  const [isLoadingPageDetails, setIsLoadingPageDetails] = useState(false);
  const [loadedImageId, setLoadedImageId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(() => {
    const saved = localStorage.getItem("manga_zoom");
    const parsed = parseFloat(saved || "1.0");
    return isNaN(parsed) ? 1.0 : parsed;
  });

  // Phase 4 Layer System states
  const [layers, setLayers] = useState<
    { layer: Layer; elements: LayerElement[] }[]
  >([]);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [cleanScanlationView, setCleanScanlationView] = useState(() => {
    const saved = localStorage.getItem("manga_clean_view");
    return saved === null ? false : saved === "true";
  });
  const [manuallyShownOcrLayers, setManuallyShownOcrLayers] = useState<
    Set<string>
  >(new Set());
  const [undoStack, setUndoStack] = useState<LayerElement[]>([]);
  const [redoStack, setRedoStack] = useState<LayerElement[]>([]);

  // Conversation and Layout enhancements
  const [groupByConversation, setGroupByConversation] = useState(() => {
    const saved = localStorage.getItem("manga_group_by_conversation");
    return saved === null ? true : saved === "true";
  });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedItem, setSelectedItem] = useState<SelectedItemType>(null);
  const [activeItem, setActiveItem] = useState<RenderItem | null>(null);
  const [fitMode, setFitMode] = useState<"page" | "width" | "height">(() => {
    const saved = localStorage.getItem("manga_fit_mode");
    return saved === "page" || saved === "width" || saved === "height"
      ? saved
      : "page";
  });
  const [isRedoingPageOcr, setIsRedoingPageOcr] = useState(false);
  const [isRedoingPageTranslation, setIsRedoingPageTranslation] =
    useState(false);

  // Pan & Drag States
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDraggingCanvas, setIsDraggingCanvas] = useState(false);
  /** 'none' = normal read mode, 'drag' = move element, 'reshape' = vertex editing */
  const [interactionMode, setInteractionMode] = useState<
    "none" | "drag" | "reshape"
  >("none");
  const dragStart = useRef({ x: 0, y: 0 });
  const [draggedElement, setDraggedElement] = useState<{
    id: string;
    type: "move";
    startX: number;
    startY: number;
    startElX: number;
    startElY: number;
    startElW: number;
    startElH: number;
    /** Polygon vertices at drag start (for polygon-shaped elements) */
    startPolygon: Polygon | null;
  } | null>(null);

  /** Tracks a single polygon vertex being dragged in reshape mode */
  const [draggedVertex, setDraggedVertex] = useState<{
    elementId: string;
    vertexIndex: number;
    startMouseX: number;
    startMouseY: number;
    originalPolygon: Polygon;
    originalX: number;
    originalY: number;
    originalW: number;
    originalH: number;
  } | null>(null);

  /** Tracks the rotation handle being dragged in reshape mode */
  const [rotationDrag, setRotationDrag] = useState<{
    elementId: string;
    startAngleDeg: number;
    originalPolygon: Polygon;
    centroid: Point;
    originalX: number;
    originalY: number;
    originalW: number;
    originalH: number;
  } | null>(null);

  /** Minimum polygon area in square SVG-coord pixels (~36px font, 2 chars) */
  const MIN_POLYGON_AREA = 1296;

  // Touch & Zoom enhancements
  // Detected once at component initialization — never changes after mount
  const isTouchScreen =
    "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const [containerSize, setContainerSize] = useState({
    width: 800,
    height: 600,
  });

  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const touchStartDist = useRef<number | null>(null);
  const touchStartZoom = useRef<number>(1.0);
  const initialTouchPos = useRef({ x: 0, y: 0 });
  const hasMoved = useRef(false);

  const { notifications } = useNotifications();
  const { showToast, showSuccess, showError } = useToast();

  const [dirtyElements, setDirtyElements] = useState<Set<string>>(new Set());
  const autoSaveTimersRef = useRef<Record<string, NodeJS.Timeout>>({});

  useEffect(() => {
    const timers = autoSaveTimersRef.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  // Listen for new notifications and refresh page if processing completed
  const latestNotificationId =
    notifications.length > 0 ? notifications[0].id : null;
  useEffect(() => {
    if (notifications.length > 0) {
      const latest = notifications[0];
      if (latest && selectedPage) {
        const isCurrentImage =
          !latest.imageId || latest.imageId === selectedPage.imageId;
        const isLayerUpdate =
          latest.title === "OCR Completed" ||
          latest.title === "Translation Completed";
        if (isCurrentImage && isLayerUpdate) {
          console.log(
            `SSE event: Reloading page layers due to ${latest.title}`,
          );
          // Force refetch of page details by clearing the loaded image ID
          Promise.resolve().then(() => {
            setLoadedImageId(null);
          });
        }
      }
    }
  }, [latestNotificationId, selectedPage, notifications]);

  // Persistence effects
  useEffect(() => {
    localStorage.setItem("manga_show_panels", showPanels.toString());
  }, [showPanels]);

  useEffect(() => {
    localStorage.setItem("manga_show_ocr", showOcr.toString());
  }, [showOcr]);

  useEffect(() => {
    localStorage.setItem("manga_show_left_sidebar", showLeftSidebar.toString());
  }, [showLeftSidebar]);

  useEffect(() => {
    localStorage.setItem(
      "manga_show_right_sidebar",
      showRightSidebar.toString(),
    );
  }, [showRightSidebar]);

  useEffect(() => {
    localStorage.setItem("manga_clean_view", cleanScanlationView.toString());
  }, [cleanScanlationView]);

  useEffect(() => {
    localStorage.setItem(
      "manga_group_by_conversation",
      groupByConversation.toString(),
    );
  }, [groupByConversation]);

  useEffect(() => {
    localStorage.setItem("manga_fit_mode", fitMode);
  }, [fitMode]);

  useEffect(() => {
    localStorage.setItem("manga_zoom", zoom.toString());
  }, [zoom]);

  // Window title synchronization
  useEffect(() => {
    if (selectedChapter) {
      const seriesTitle = selectedSeries ? selectedSeries.title : "Series";
      const chapterNum = selectedChapter.chapterNumber;
      const pageNum = curPageNum;
      document.title = `[tl-hub] ${seriesTitle} - Ch. ${chapterNum} Page ${pageNum}`;
    } else {
      document.title = "tl-hub - Manga Translation Platform";
    }
    return () => {
      document.title = "tl-hub";
    };
  }, [selectedSeries, selectedChapter, curPageNum]);

  // Chapter navigation logic
  const sortedChapters = [...chapters].sort(
    (a, b) => a.chapterNumber - b.chapterNumber,
  );
  const currentChapterIdx = sortedChapters.findIndex(
    (c) => c.id === selectedChapter?.id,
  );
  const prevChapter =
    currentChapterIdx > 0
      ? sortedChapters.at(currentChapterIdx - 1) || null
      : null;
  const nextChapter =
    currentChapterIdx !== -1 && currentChapterIdx < sortedChapters.length - 1
      ? sortedChapters.at(currentChapterIdx + 1) || null
      : null;

  const navigateToChapter = (chapter: Chapter) => {
    const slugPart = chapter.title
      ? `${toSlug(chapter.title)}/`
      : `chapter-${chapter.chapterNumber}/`;
    navigate(`/chapters/${chapter.id}/${slugPart}reader/1`);
  };

  // isTouchScreen is detected once at mount — no effect needed, computed directly
  // (avoids react-hooks/set-state-in-effect lint error)

  useEffect(() => {
    if (!canvasAreaRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    resizeObserver.observe(canvasAreaRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText?: string;
    isDangerous?: boolean;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: "",
    message: "",
    onConfirm: () => {},
  });

  const closeConfirm = () =>
    setConfirmModal((prev) => ({ ...prev, isOpen: false }));

  // Info modal state (replaces browser alert)
  const [infoModal, setInfoModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    type: "success" | "error" | "info";
  }>({
    isOpen: false,
    title: "",
    message: "",
    type: "info",
  });

  const showInfo = (
    title: string,
    message: string,
    type: "success" | "error" | "info" = "info",
  ) => setInfoModal({ isOpen: true, title, message, type });
  const closeInfo = () => setInfoModal((prev) => ({ ...prev, isOpen: false }));

  // Image ref for export
  const imgRef = useRef<HTMLImageElement>(null);

  // Popover States
  const [activeRegion, setActiveRegion] = useState<OcrRegion | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [isEditingRegion, setIsEditingRegion] = useState(false);
  const [editText, setEditText] = useState("");
  const [isRedoing, setIsRedoing] = useState(false);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Helper to get combined text (original or translated) for a grouped item
  const getCombinedText = useCallback(
    (item: RenderItem, showTrans: boolean) => {
      if (!item || !item.regions) return "";
      return item.regions
        .map((r: OcrRegion) => (showTrans ? r.translatedText || "" : r.text))
        .join("\n");
    },
    [],
  );

  const visibleOcrRegionIds = React.useMemo(() => {
    const ids = new Set<string>();
    layers.forEach((lData) => {
      if (lData.layer.type === "ocr" && lData.layer.visible) {
        lData.elements.forEach((el) => {
          if (el.regionId) ids.add(el.regionId);
        });
      }
    });
    return ids;
  }, [layers]);

  const filteredOcrRegions = React.useMemo(() => {
    const hasOcrLayer = layers.some((lData) => lData.layer.type === "ocr");
    if (!hasOcrLayer) return ocrRegions;
    return ocrRegions.filter((r) => visibleOcrRegionIds.has(r.id));
  }, [ocrRegions, layers, visibleOcrRegionIds]);

  const filteredConversations = React.useMemo(() => {
    const hasOcrLayer = layers.some((lData) => lData.layer.type === "ocr");
    if (!hasOcrLayer) return conversations;
    return conversations.filter((conv) =>
      conv.regions.some((cr) => visibleOcrRegionIds.has(cr.regionId)),
    );
  }, [conversations, layers, visibleOcrRegionIds]);

  const sortedLayers = React.useMemo(() => {
    return [...layers].sort((a, b) => a.layer.zOrder - b.layer.zOrder);
  }, [layers]);

  // Compute union bounding box for conversations
  const conversationsWithRegions = React.useMemo(() => {
    if (!groupByConversation || filteredConversations.length === 0) {
      return [];
    }

    return filteredConversations
      .map((conv) => {
        const regionsInConv = conv.regions
          .map((cr) => filteredOcrRegions.find((r) => r.id === cr.regionId))
          .filter((r): r is OcrRegion => !!r);

        let bboxX = 0,
          bboxY = 0,
          bboxW = 0,
          bboxH = 0;
        if (regionsInConv.length > 0) {
          const minX = Math.min(...regionsInConv.map((r) => r.bboxX));
          const minY = Math.min(...regionsInConv.map((r) => r.bboxY));
          const maxX = Math.max(...regionsInConv.map((r) => r.bboxX + r.bboxW));
          const maxY = Math.max(...regionsInConv.map((r) => r.bboxY + r.bboxH));
          bboxX = minX;
          bboxY = minY;
          bboxW = maxX - minX;
          bboxH = maxY - minY;
        }

        return {
          ...conv,
          regions: regionsInConv,
          bboxX,
          bboxY,
          bboxW,
          bboxH,
          approved:
            regionsInConv.length > 0 && regionsInConv.every((r) => r.approved),
        };
      })
      .filter((c) => c.regions.length > 0);
  }, [filteredConversations, filteredOcrRegions, groupByConversation]);

  // Unified list of renderable items (conversations or standalone regions)
  const renderItems = React.useMemo(() => {
    if (!groupByConversation || filteredConversations.length === 0) {
      return filteredOcrRegions.map((r) => ({
        id: `region-${r.id}`,
        isConversation: false,
        regions: [r],
        bboxX: r.bboxX,
        bboxY: r.bboxY,
        bboxW: r.bboxW,
        bboxH: r.bboxH,
        approved: r.approved === true,
        sceneType: "speech",
        originalRegion: r,
      }));
    }

    const groupedRegionIds = new Set(
      filteredConversations.flatMap((c) => c.regions.map((r) => r.regionId)),
    );

    const convItems = conversationsWithRegions.map((conv) => ({
      id: `conv-${conv.id}`,
      isConversation: true,
      regions: conv.regions,
      bboxX: conv.bboxX,
      bboxY: conv.bboxY,
      bboxW: conv.bboxW,
      bboxH: conv.bboxH,
      approved: conv.approved,
      sceneType: conv.sceneType,
      conversationData: conv,
    }));

    const ungroupedItems = filteredOcrRegions
      .filter((r) => !groupedRegionIds.has(r.id))
      .map((r) => ({
        id: `region-${r.id}`,
        isConversation: false,
        regions: [r],
        bboxX: r.bboxX,
        bboxY: r.bboxY,
        bboxW: r.bboxW,
        bboxH: r.bboxH,
        approved: r.approved === true,
        sceneType: "speech",
        originalRegion: r,
      }));

    return [...convItems, ...ungroupedItems];
  }, [
    groupByConversation,
    filteredOcrRegions,
    filteredConversations,
    conversationsWithRegions,
  ]);

  // Dynamic calculation of the absolute zoom percentage
  const displayedZoom = React.useMemo(() => {
    if (imageDims.w <= 0 || imageDims.h <= 0) return 100;
    const aspectRatio = imageDims.w / imageDims.h;
    const vh = window.innerHeight;
    const containerWidth = Math.max(100, containerSize.width - 48); // 24px padding on each side
    const refWidth = Math.min(containerWidth, vh * 0.8 * aspectRatio);

    let targetWidth = refWidth;
    if (fitMode === "page") {
      targetWidth = refWidth * zoom;
    } else if (fitMode === "width") {
      targetWidth = containerWidth * zoom;
    } else if (fitMode === "height") {
      targetWidth = vh * 0.85 * aspectRatio * zoom;
    }

    return Math.round((targetWidth / refWidth) * 100);
  }, [fitMode, zoom, containerSize, imageDims]);

  // Fetch page details (panels, OCR regions, conversations) when page selection updates
  useEffect(() => {
    if (selectedPage && loadedImageId !== selectedPage.imageId) {
      // Defer loading indicator setting to satisfy StrictEffect synchronous state update limits
      Promise.resolve().then(() => {
        setIsLoadingPageDetails(true);
      });

      safeFetch(`/api/images/${selectedPage.imageId}`, {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((res) => {
          if (!res.ok) throw new Error("Image details fetch failed");
          return res.json();
        })
        .then((data) => {
          setPanels(data.panels || []);
          setOcrRegions(data.ocrRegions || []);
          setConversations(data.conversations || []);
          setSelectedItem(null);
          setLoadedImageId(selectedPage.imageId);
          setIsLoadingPageDetails(false);
        })
        .catch((err) => {
          console.error("Error loading page details:", err);
          setIsLoadingPageDetails(false);
        });

      // Fetch layers
      safeFetch(`/api/images/${selectedPage.imageId}/layers`, {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((res) => {
          if (!res.ok) throw new Error("Layers fetch failed");
          return res.json();
        })
        .then((layersData) => {
          const data = layersData || [];
          setLayers(data);
          if (data.length > 0) {
            setActiveLayerId(data[0].layer.id);
          } else {
            setActiveLayerId(null);
          }
        })
        .catch((err) => {
          console.error("Error loading layers:", err);
        });
    }
  }, [selectedPage, loadedImageId, user.token]);

  // Reset pan/zoom on page changes
  useEffect(() => {
    Promise.resolve().then(() => {
      setZoom(1.0);
      setPan({ x: 0, y: 0 });
      setSelectedItem(null);
      setActiveRegion(null);
      setActiveItem(null);
      setPopoverOpen(false);
      setUndoStack([]);
      setRedoStack([]);
      setInteractionMode("none");
    });
  }, [pageNumber]);

  // Reset interaction mode on selectedItem ID changes
  const prevSelectedItemIdRef = useRef<string | number | null>(null);
  useEffect(() => {
    const currentId = selectedItem?.id || null;
    if (currentId !== prevSelectedItemIdRef.current) {
      prevSelectedItemIdRef.current = currentId;
      setInteractionMode("none");
    }
  }, [selectedItem]);

  // History Undo/Redo operations
  const pushToHistoryStack = useCallback((prevState: LayerElement) => {
    setUndoStack((prev) => [...prev.slice(-49), { ...prevState }]);
    setRedoStack([]);
  }, []);

  // Declared before handleUndo/handleRedo so the callbacks can reference it
  const handleSaveElementChanges = useCallback(
    async (element: LayerElement, showAlert: boolean = true) => {
      const id = element.id;
      if (autoSaveTimersRef.current[id]) {
        clearTimeout(autoSaveTimersRef.current[id]);
        delete autoSaveTimersRef.current[id];
      }
      await saveElementChanges(
        element,
        showAlert,
        user.token,
        showToast,
        showError,
      );
      setDirtyElements((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [user.token, showToast, showError],
  );

  const triggerAutoSave = useCallback(
    (element: LayerElement) => {
      const id = element.id;
      setDirtyElements((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });

      if (autoSaveTimersRef.current[id]) {
        clearTimeout(autoSaveTimersRef.current[id]);
      }

      autoSaveTimersRef.current[id] = setTimeout(async () => {
        try {
          await saveElementChanges(
            element,
            false,
            user.token,
            showToast,
            showError,
          );
          setDirtyElements((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        } catch (err) {
          console.error("Auto-save failed for element:", id, err);
        } finally {
          delete autoSaveTimersRef.current[id];
        }
      }, 1500);
    },
    [user.token, showToast, showError],
  );

  const saveAllPendingChanges = useCallback(async (): Promise<void> => {
    const pendingIds = Object.keys(autoSaveTimersRef.current);
    if (pendingIds.length === 0) return;

    const elementsToSave: LayerElement[] = [];
    layers.forEach((l) => {
      l.elements.forEach((el) => {
        if (pendingIds.includes(el.id)) {
          elementsToSave.push(el);
        }
      });
    });

    const promises = elementsToSave.map(async (el) => {
      const id = el.id;
      if (autoSaveTimersRef.current[id]) {
        clearTimeout(autoSaveTimersRef.current[id]);
        delete autoSaveTimersRef.current[id];
      }
      try {
        await saveElementChanges(el, false, user.token, showToast, showError);
      } catch (err) {
        console.error("Failed to save pending changes for element", id, err);
        throw err;
      }
    });

    await Promise.all(promises);
    setDirtyElements(new Set());
  }, [layers, user.token, showToast, showError]);

  const handleUndo = useCallback(async () => {
    if (undoStack.length === 0) return;
    const previous = undoStack.at(-1);
    if (!previous) return;
    setUndoStack((prev) => prev.slice(0, -1));

    let currentElement: LayerElement | undefined;
    setLayers((prevLayers) => {
      let found: LayerElement | undefined;
      for (const l of prevLayers) {
        const el = l.elements.find((e) => e.id === previous.id);
        if (el) {
          found = el;
          break;
        }
      }
      if (found) {
        currentElement = { ...found };
      }

      return prevLayers.map((l) => {
        if (l.layer.id === previous.layerId) {
          return {
            ...l,
            elements: l.elements.map((el) =>
              el.id === previous.id ? previous : el,
            ),
          };
        }
        return l;
      });
    });

    if (currentElement) {
      setRedoStack((prev) => [...prev, currentElement as LayerElement]);
    }

    setSelectedItem((prev) =>
      prev && prev.id === previous.id
        ? ({ ...previous, isLayerElement: true } as SelectedItemType)
        : prev,
    );

    await handleSaveElementChanges(previous, false);
  }, [undoStack, handleSaveElementChanges]);

  const handleRedo = useCallback(async () => {
    if (redoStack.length === 0) return;
    const next = redoStack.at(-1);
    if (!next) return;
    setRedoStack((prev) => prev.slice(0, -1));

    let currentElement: LayerElement | undefined;
    setLayers((prevLayers) => {
      let found: LayerElement | undefined;
      for (const l of prevLayers) {
        const el = l.elements.find((e) => e.id === next.id);
        if (el) {
          found = el;
          break;
        }
      }
      if (found) {
        currentElement = { ...found };
      }

      return prevLayers.map((l) => {
        if (l.layer.id === next.layerId) {
          return {
            ...l,
            elements: l.elements.map((el) => (el.id === next.id ? next : el)),
          };
        }
        return l;
      });
    });

    if (currentElement) {
      setUndoStack((prev) => [...prev, currentElement as LayerElement]);
    }

    setSelectedItem((prev) =>
      prev && prev.id === next.id
        ? ({ ...next, isLayerElement: true } as SelectedItemType)
        : prev,
    );

    await handleSaveElementChanges(next, false);
  }, [redoStack, handleSaveElementChanges]);

  const handleMoveLayer = useCallback(
    async (layerId: string, direction: "up" | "down") => {
      if (!layerId) return;

      // Use a function state update to get the latest layers safely
      setLayers((prev) => {
        if (prev.length <= 1) return prev;

        const sorted = [...prev].sort(
          (a, b) => a.layer.zOrder - b.layer.zOrder,
        );
        const currentIndex = sorted.findIndex((l) => l.layer.id === layerId);
        if (currentIndex === -1) return prev;

        if (direction === "up" && currentIndex === sorted.length - 1)
          return prev;
        if (direction === "down" && currentIndex === 0) return prev;

        const targetIndex =
          direction === "up" ? currentIndex + 1 : currentIndex - 1;

        const newSorted = [...sorted];
        [newSorted[currentIndex], newSorted[targetIndex]] = [
          newSorted[targetIndex],
          newSorted[currentIndex],
        ];

        const updatedLayersData = newSorted.map((lData, index) => ({
          ...lData,
          layer: { ...lData.layer, zOrder: index },
        }));

        const updates = updatedLayersData.filter((l) => {
          const old = prev.find((oldL) => oldL.layer.id === l.layer.id);
          return !old || old.layer.zOrder !== l.layer.zOrder;
        });

        // Fire async requests
        updates.forEach((lData) => {
          safeFetch(`/api/layers/${lData.layer.id}`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${user.token}`,
            },
            body: JSON.stringify({ zOrder: lData.layer.zOrder }),
          }).catch((err) =>
            console.error("Failed to update layer zOrder:", err),
          );
        });

        return updatedLayersData;
      });
    },
    [user.token],
  );

  // Key Down Listener for undo/redo and layer reordering
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
      } else if (e.shiftKey && e.key === "ArrowUp") {
        e.preventDefault();
        if (activeLayerId) handleMoveLayer(activeLayerId, "up");
      } else if (e.shiftKey && e.key === "ArrowDown") {
        e.preventDefault();
        if (activeLayerId) handleMoveLayer(activeLayerId, "down");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleUndo, handleRedo, activeLayerId, handleMoveLayer]);

  const handleUpdateSelectedElement = (updates: Partial<LayerElement>) => {
    setSelectedItem((prev: SelectedItemType) => {
      if (!prev) return null;

      // Push previous state to undo stack
      pushToHistoryStack(prev as LayerElement);

      const updated = { ...prev, ...updates } as LayerElement;

      setLayers((prevLayers) =>
        prevLayers.map((l) => {
          if (l.layer.id === updated.layerId) {
            return {
              ...l,
              elements: l.elements.map((el) =>
                el.id === updated.id ? updated : el,
              ),
            };
          }
          return l;
        }),
      );

      triggerAutoSave(updated);

      return updated as SelectedItemType;
    });
  };

  const handleElementDragStart = (
    e: React.PointerEvent,
    element: LayerElement,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const svg = (e.target as Element).closest("svg") as SVGSVGElement | null;
    if (!svg) return;
    const point = svg.createSVGPoint();
    point.x = e.clientX;
    point.y = e.clientY;
    const svgPoint = point.matrixTransform(svg.getScreenCTM()!.inverse());

    let startPolygon: Polygon | null = null;
    if (element.maskPolygon) {
      try {
        startPolygon = JSON.parse(element.maskPolygon) as Polygon;
      } catch {
        /* ignore */
      }
    }

    setDraggedElement({
      id: element.id,
      type: "move",
      startX: svgPoint.x,
      startY: svgPoint.y,
      startElX: element.x,
      startElY: element.y,
      startElW: element.maxWidth || 100,
      startElH: element.maxHeight || 100,
      startPolygon,
    });
  };

  useEffect(() => {
    if (!draggedElement) return;

    const handlePointerMove = (e: PointerEvent) => {
      const svg = document.querySelector(
        ".svg-overlay",
      ) as SVGSVGElement | null;
      if (!svg) return;

      const point = svg.createSVGPoint();
      point.x = e.clientX;
      point.y = e.clientY;
      const svgPoint = point.matrixTransform(svg.getScreenCTM()!.inverse());

      const dx = svgPoint.x - draggedElement.startX;
      const dy = svgPoint.y - draggedElement.startY;

      // Clamp position within image bounds
      const newX = Math.max(
        0,
        Math.min(
          imageDims.w - draggedElement.startElW,
          Math.round(draggedElement.startElX + dx),
        ),
      );
      const newY = Math.max(
        0,
        Math.min(
          imageDims.h - draggedElement.startElH,
          Math.round(draggedElement.startElY + dy),
        ),
      );

      // Derive actual clamped deltas for polygon translation
      const clampedDx = newX - draggedElement.startElX;
      const clampedDy = newY - draggedElement.startElY;

      let newMaskPolygon: string | null | undefined = undefined; // undefined = no change
      if (draggedElement.startPolygon) {
        const translated = translatePolygon(
          draggedElement.startPolygon,
          clampedDx,
          clampedDy,
        );
        newMaskPolygon = JSON.stringify(translated);
      }

      setSelectedItem((prev) => {
        if (prev && "id" in prev && prev.id === draggedElement.id) {
          return {
            ...prev,
            x: newX,
            y: newY,
            ...(newMaskPolygon !== undefined
              ? { maskPolygon: newMaskPolygon }
              : {}),
          };
        }
        return prev;
      });

      setLayers((prevLayers) =>
        prevLayers.map((l) => {
          const hasElement = l.elements.some(
            (el) => el.id === draggedElement.id,
          );
          if (hasElement) {
            return {
              ...l,
              elements: l.elements.map((el) =>
                el.id === draggedElement.id
                  ? {
                      ...el,
                      x: newX,
                      y: newY,
                      ...(newMaskPolygon !== undefined
                        ? { maskPolygon: newMaskPolygon }
                        : {}),
                    }
                  : el,
              ),
            };
          }
          return l;
        }),
      );
    };

    const handlePointerUp = async () => {
      if (!draggedElement) return;

      setLayers((prevLayers) => {
        let updatedElement: LayerElement | undefined;
        for (const layer of prevLayers) {
          const found = layer.elements.find(
            (el) => el.id === draggedElement.id,
          );
          if (found) {
            updatedElement = found;
            break;
          }
        }

        if (updatedElement) {
          const originalElement: LayerElement = {
            ...(updatedElement as LayerElement),
            x: draggedElement.startElX,
            y: draggedElement.startElY,
            maxWidth: draggedElement.startElW,
            maxHeight: draggedElement.startElH,
            maskPolygon: draggedElement.startPolygon
              ? JSON.stringify(draggedElement.startPolygon)
              : (updatedElement as LayerElement).maskPolygon,
          };
          setTimeout(() => {
            pushToHistoryStack(originalElement);
            handleSaveElementChanges(updatedElement!, false);
          }, 0);
        }
        return prevLayers;
      });

      setDraggedElement(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [draggedElement, imageDims, pushToHistoryStack, handleSaveElementChanges]);

  // ---------------------------------------------------------------------------
  // RESHAPE MODE: Enter reshape (auto-generating polygon for rect/ellipse)
  // ---------------------------------------------------------------------------

  const handleEnterReshapeMode = useCallback(
    (element: LayerElement) => {
      if (!element.maskPolygon) {
        // Auto-generate a polygon from the element's bounding box / shape
        const x = element.x,
          y = element.y;
        const w = element.maxWidth || 100,
          h = element.maxHeight || 100;
        const rotation = element.rotation || 0;
        let polygon: Polygon;
        if (element.boxShape === "elliptical") {
          polygon = ellipseToPolygon(
            x + w / 2,
            y + h / 2,
            w / 2,
            h / 2,
            rotation,
            12,
          );
        } else {
          polygon = rectToPolygon(x, y, w, h, rotation);
        }
        // Bake rotation into polygon — the element's rotation field becomes 0
        const newMaskPolygon = JSON.stringify(
          polygon.map(([px, py]) => [Math.round(px), Math.round(py)]),
        );

        // Capture state for undo before we mutate
        pushToHistoryStack(element as LayerElement);

        const updates: Partial<LayerElement> = {
          maskPolygon: newMaskPolygon,
          rotation: 0,
        };
        setSelectedItem((prev) => (prev ? { ...prev, ...updates } : prev));
        setLayers((prev) =>
          prev.map((l) => ({
            ...l,
            elements: l.elements.map((el) =>
              el.id === element.id ? { ...el, ...updates } : el,
            ),
          })),
        );
        // Persist immediately
        handleSaveElementChanges(
          { ...element, ...updates } as LayerElement,
          false,
        );
      }
      setInteractionMode("reshape");
    },
    [pushToHistoryStack, handleSaveElementChanges],
  );

  // ---------------------------------------------------------------------------
  // RESHAPE MODE: Vertex drag
  // ---------------------------------------------------------------------------

  const handleVertexDragStart = (
    e: React.PointerEvent,
    element: LayerElement,
    vertexIndex: number,
    polygon: Polygon,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const svg = (e.target as Element).closest("svg") as SVGSVGElement | null;
    if (!svg) return;
    const point = svg.createSVGPoint();
    point.x = e.clientX;
    point.y = e.clientY;
    const svgPt = point.matrixTransform(svg.getScreenCTM()!.inverse());

    setDraggedVertex({
      elementId: element.id,
      vertexIndex,
      startMouseX: svgPt.x,
      startMouseY: svgPt.y,
      originalPolygon: polygon.map((p) => [...p]) as Polygon,
      originalX: element.x,
      originalY: element.y,
      originalW: element.maxWidth || 100,
      originalH: element.maxHeight || 100,
    });
  };

  useEffect(() => {
    if (!draggedVertex) return;

    const handlePointerMove = (e: PointerEvent) => {
      const svg = document.querySelector(
        ".svg-overlay",
      ) as SVGSVGElement | null;
      if (!svg) return;
      const point = svg.createSVGPoint();
      point.x = e.clientX;
      point.y = e.clientY;
      const svgPt = point.matrixTransform(svg.getScreenCTM()!.inverse());

      // Clamp new vertex position within image bounds
      const newPos: Point = [
        Math.round(Math.max(0, Math.min(imageDims.w, svgPt.x))),
        Math.round(Math.max(0, Math.min(imageDims.h, svgPt.y))),
      ];

      if (
        !isVertexMoveValid(
          draggedVertex.originalPolygon,
          draggedVertex.vertexIndex,
          newPos,
          imageDims,
          MIN_POLYGON_AREA,
        )
      )
        return; // Reject invalid moves silently

      const newPoly = draggedVertex.originalPolygon.map((v, i) =>
        i === draggedVertex.vertexIndex ? newPos : ([...v] as Point),
      ) as Polygon;
      const bbox = polygonBBox(newPoly);
      const newMaskPolygon = JSON.stringify(newPoly);

      setSelectedItem((prev) =>
        prev && prev.id === draggedVertex.elementId
          ? {
              ...prev,
              maskPolygon: newMaskPolygon,
              x: bbox.x,
              y: bbox.y,
              maxWidth: bbox.w,
              maxHeight: bbox.h,
            }
          : prev,
      );
      setLayers((prev) =>
        prev.map((l) => ({
          ...l,
          elements: l.elements.map((el) =>
            el.id === draggedVertex.elementId
              ? {
                  ...el,
                  maskPolygon: newMaskPolygon,
                  x: bbox.x,
                  y: bbox.y,
                  maxWidth: bbox.w,
                  maxHeight: bbox.h,
                }
              : el,
          ),
        })),
      );
    };

    const handlePointerUp = async () => {
      // Find updated element
      setLayers((prev) => {
        let updatedElement: LayerElement | undefined;
        for (const l of prev) {
          const found = l.elements.find(
            (el) => el.id === draggedVertex.elementId,
          );
          if (found) {
            updatedElement = found;
            break;
          }
        }

        if (updatedElement) {
          const origBbox = polygonBBox(draggedVertex.originalPolygon);
          const originalElement: LayerElement = {
            ...(updatedElement as LayerElement),
            maskPolygon: JSON.stringify(draggedVertex.originalPolygon),
            x: origBbox.x,
            y: origBbox.y,
            maxWidth: origBbox.w,
            maxHeight: origBbox.h,
          };
          setTimeout(() => {
            pushToHistoryStack(originalElement);
            handleSaveElementChanges(updatedElement!, false);
          }, 0);
        }
        return prev;
      });
      setDraggedVertex(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [
    draggedVertex,
    imageDims,
    MIN_POLYGON_AREA,
    pushToHistoryStack,
    handleSaveElementChanges,
  ]);

  // ---------------------------------------------------------------------------
  // RESHAPE MODE: Rotation handle drag
  // ---------------------------------------------------------------------------

  const handleRotationDragStart = (
    e: React.PointerEvent,
    element: LayerElement,
    polygon: Polygon,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const svg = (e.target as Element).closest("svg") as SVGSVGElement | null;
    if (!svg) return;
    const point = svg.createSVGPoint();
    point.x = e.clientX;
    point.y = e.clientY;
    const svgPt = point.matrixTransform(svg.getScreenCTM()!.inverse());

    const centroid = polygonCentroid(polygon);
    const startAngleDeg =
      Math.atan2(svgPt.y - centroid[1], svgPt.x - centroid[0]) *
      (180 / Math.PI);

    setRotationDrag({
      elementId: element.id,
      startAngleDeg,
      originalPolygon: polygon.map((p) => [...p]) as Polygon,
      centroid,
      originalX: element.x,
      originalY: element.y,
      originalW: element.maxWidth || 100,
      originalH: element.maxHeight || 100,
    });
  };

  useEffect(() => {
    if (!rotationDrag) return;

    const handlePointerMove = (e: PointerEvent) => {
      const svg = document.querySelector(
        ".svg-overlay",
      ) as SVGSVGElement | null;
      if (!svg) return;
      const point = svg.createSVGPoint();
      point.x = e.clientX;
      point.y = e.clientY;
      const svgPt = point.matrixTransform(svg.getScreenCTM()!.inverse());

      const currentAngleDeg =
        Math.atan2(
          svgPt.y - rotationDrag.centroid[1],
          svgPt.x - rotationDrag.centroid[0],
        ) *
        (180 / Math.PI);
      const deltaAngle = currentAngleDeg - rotationDrag.startAngleDeg;

      const rotatedPoly = rotatePolygon(
        rotationDrag.originalPolygon,
        rotationDrag.centroid,
        deltaAngle,
      );

      if (!isRotationValid(rotatedPoly, imageDims)) return; // All verts must stay in image

      const bbox = polygonBBox(rotatedPoly);
      const newMaskPolygon = JSON.stringify(
        rotatedPoly.map(([px, py]) => [Math.round(px), Math.round(py)]),
      );

      setSelectedItem((prev) =>
        prev && prev.id === rotationDrag.elementId
          ? {
              ...prev,
              maskPolygon: newMaskPolygon,
              x: bbox.x,
              y: bbox.y,
              maxWidth: bbox.w,
              maxHeight: bbox.h,
            }
          : prev,
      );
      setLayers((prev) =>
        prev.map((l) => ({
          ...l,
          elements: l.elements.map((el) =>
            el.id === rotationDrag.elementId
              ? {
                  ...el,
                  maskPolygon: newMaskPolygon,
                  x: bbox.x,
                  y: bbox.y,
                  maxWidth: bbox.w,
                  maxHeight: bbox.h,
                }
              : el,
          ),
        })),
      );
    };

    const handlePointerUp = async () => {
      setLayers((prev) => {
        let updatedElement: LayerElement | undefined;
        for (const l of prev) {
          const found = l.elements.find(
            (el) => el.id === rotationDrag.elementId,
          );
          if (found) {
            updatedElement = found;
            break;
          }
        }

        if (updatedElement) {
          const origBbox = polygonBBox(rotationDrag.originalPolygon);
          const originalElement: LayerElement = {
            ...(updatedElement as LayerElement),
            maskPolygon: JSON.stringify(rotationDrag.originalPolygon),
            x: origBbox.x,
            y: origBbox.y,
            maxWidth: origBbox.w,
            maxHeight: origBbox.h,
          };
          setTimeout(() => {
            pushToHistoryStack(originalElement);
            handleSaveElementChanges(updatedElement!, false);
          }, 0);
        }
        return prev;
      });
      setRotationDrag(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [rotationDrag, imageDims, pushToHistoryStack, handleSaveElementChanges]);

  const handleCreateLayer = async (type: "translation" | "sfx") => {
    if (!selectedPage) return;
    let targetLanguage: string | null = null;
    if (type === "translation") {
      targetLanguage = prompt(
        "Enter target language code (e.g. en, es, fr):",
        "en",
      );
      if (!targetLanguage) return;
    }

    try {
      const res = await safeFetch(
        `/api/images/${selectedPage.imageId}/layers`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${user.token}`,
          },
          body: JSON.stringify({
            type,
            targetLanguage: targetLanguage
              ? targetLanguage.toLowerCase()
              : null,
            visible: true,
            zOrder: layers.length,
          }),
        },
      );

      if (!res.ok) throw new Error("Failed to create layer");

      const newLayer = await res.json();
      setLayers((prev) => [...prev, { layer: newLayer, elements: [] }]);
      setActiveLayerId(newLayer.id);
    } catch (err) {
      console.error(err);
      alert("Error creating layer.");
    }
  };

  const handleCreateTranslationLayer = () => handleCreateLayer("translation");
  const handleCreateSfxLayer = () => handleCreateLayer("sfx");

  const handleAddNewElement = async (type: "text" | "mask") => {
    if (!activeLayerId) {
      alert("Please select or create an active layer first.");
      return;
    }

    try {
      const res = await safeFetch(`/api/layers/${activeLayerId}/elements`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({
          text: type === "text" ? "New Text" : "",
          font: "Comic Neue",
          size: 16.0,
          autoSize: false,
          maxWidth: type === "text" ? 150 : 100,
          maxHeight: type === "text" ? 80 : 100,
          wordWrap: type === "mask",
          rotation: 0.0,
          x: 100.0,
          y: 100.0,
          visible: true,
          backgroundColor: type === "mask" ? "#ffffff" : null,
          textColor: type === "text" ? "#000000" : null,
          fontWeight: "normal",
          fontStyle: "normal",
        }),
      });

      if (!res.ok) throw new Error("Failed to create layer element");

      const newElement = await res.json();
      const elementWithFlag = { ...newElement, isLayerElement: true };

      setLayers((prevLayers) =>
        prevLayers.map((l) => {
          if (l.layer.id === activeLayerId) {
            return {
              ...l,
              elements: [...l.elements, elementWithFlag],
            };
          }
          return l;
        }),
      );

      setSelectedItem(elementWithFlag);
    } catch (err) {
      console.error(err);
      alert("Error creating layer element.");
    }
  };

  const handleDeleteElement = async (elementId: string) => {
    setConfirmModal({
      isOpen: true,
      title: "Delete Element",
      message: "Are you sure you want to delete this element?",
      confirmText: "Delete",
      isDangerous: true,
      onConfirm: async () => {
        closeConfirm();
        try {
          const res = await safeFetch(`/api/layer-elements/${elementId}`, {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${user.token}`,
            },
          });

          if (!res.ok) throw new Error("Failed to delete layer element");

          setLayers((prevLayers) =>
            prevLayers.map((l) => ({
              ...l,
              elements: l.elements.filter((el) => el.id !== elementId),
            })),
          );

          setSelectedItem(null);
        } catch (err) {
          console.error(err);
          alert("Error deleting layer element.");
        }
      },
    });
  };

  const handleLaunchEyeDropper = async (
    targetField: "backgroundColor" | "textColor" = "backgroundColor",
  ) => {
    if (!selectedItem || !selectedItem.isLayerElement) {
      alert("Please select a mask or text element first.");
      return;
    }

    const win = window as unknown as {
      EyeDropper?: new () => {
        open(): Promise<{ sRGBHex: string }>;
      };
    };

    if (typeof win.EyeDropper === "undefined") {
      alert(
        "EyeDropper API is not supported in this browser. Please use the color input in the Element Inspector.",
      );
      return;
    }

    const eyeDropper = new win.EyeDropper();
    try {
      const result = await eyeDropper.open();
      const color = result.sRGBHex;
      handleUpdateSelectedElement({ [targetField]: color });
    } catch (err) {
      console.error("EyeDropper failed or cancelled:", err);
    }
  };

  const handleToggleLayerVisibility = async (layerId: string) => {
    const layerData = layers.find((l) => l.layer.id === layerId);
    if (!layerData) return;
    const nextVisible = !layerData.layer.visible;

    // Optimistic local update
    setLayers((prev) =>
      prev.map((l) => {
        if (l.layer.id === layerId) {
          if (nextVisible && cleanScanlationView && l.layer.type === "ocr") {
            setManuallyShownOcrLayers((prevShown) => {
              const nextShown = new Set(prevShown);
              nextShown.add(layerId);
              return nextShown;
            });
          }
          return { ...l, layer: { ...l.layer, visible: nextVisible } };
        }
        return l;
      }),
    );

    // Persist to backend
    try {
      await safeFetch(`/api/layers/${layerId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({ visible: nextVisible }),
      });
    } catch (err) {
      console.error("Failed to persist layer visibility toggle:", err);
    }
  };

  const handleDeleteLayer = (layerId: string) => {
    setConfirmModal({
      isOpen: true,
      title: "Delete Layer",
      message:
        "Are you sure you want to delete this layer? This action cannot be undone.",
      confirmText: "Delete Layer",
      isDangerous: true,
      onConfirm: async () => {
        closeConfirm();
        try {
          const res = await safeFetch(`/api/layers/${layerId}`, {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${user.token}`,
            },
          });

          if (!res.ok) throw new Error("Failed to delete layer");
          setLayers((prev) => prev.filter((l) => l.layer.id !== layerId));
        } catch (err) {
          console.error(err);
        }
      },
    });
  };

  /** Clones a layer: shifts all layers above it up by +1 zOrder, creates a copy at source+1,
   *  clones all elements with fresh UUIDs, then hides the source as a backup. */
  const handleCloneLayer = async (layerId: string) => {
    const sourceLayerData = layers.find((l) => l.layer.id === layerId);
    if (!sourceLayerData || !selectedPage) return;

    // Use a strict sequential index for reliable zOrder shifting
    const sorted = [...layers].sort((a, b) => a.layer.zOrder - b.layer.zOrder);
    const sourceIndex = sorted.findIndex((l) => l.layer.id === layerId);
    if (sourceIndex === -1) return;

    const sourceLayer = sourceLayerData.layer;
    const sourceElements = sourceLayerData.elements;
    const newZOrder = sourceIndex + 1;

    try {
      // Step 1: Shift layers above source up by +1 and fix any gaps
      for (let i = 0; i < sorted.length; i++) {
        const lData = sorted.at(i);
        if (!lData) continue;
        const targetZOrder = i > sourceIndex ? i + 1 : i;
        if (lData.layer.zOrder !== targetZOrder) {
          await safeFetch(`/api/layers/${lData.layer.id}`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${user.token}`,
            },
            body: JSON.stringify({ zOrder: targetZOrder }),
          });
        }
      }

      // Compute new cloned layer name
      const getLayerName = (l: Layer) => {
        if (l.metadataJson?.layer_name) return l.metadataJson.layer_name;
        if (l.type === "translation")
          return `Translation (${l.targetLanguage?.toUpperCase() || "EN"})`;
        if (l.type === "sfx") return "SFX Layer";
        if (l.type === "ocr") return "OCR Layer";
        return `Layer (${l.type})`;
      };
      const originalName = getLayerName(sourceLayer);
      const baseName = originalName.replace(/\s*\(Copy#\d+\)$/, "");
      const copyCount = layers.filter((l) =>
        getLayerName(l.layer).startsWith(baseName),
      ).length;
      const newLayerName = `${baseName} (Copy#${copyCount})`;

      // Step 3: Create the new cloned layer at newZOrder
      const createRes = await safeFetch(
        `/api/images/${selectedPage.imageId}/layers`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${user.token}`,
          },
          body: JSON.stringify({
            type: sourceLayer.type,
            targetLanguage: sourceLayer.targetLanguage,
            visible: true,
            zOrder: newZOrder,
            metadataJson: { layer_name: newLayerName },
          }),
        },
      );
      if (!createRes.ok) throw new Error("Failed to create cloned layer");
      const newLayer: Layer = await createRes.json();

      // Step 4: Clone each element — POST without IDs so the DB assigns fresh UUIDs
      const clonedElements: LayerElement[] = [];
      for (const el of sourceElements) {
        const cloneRes = await safeFetch(
          `/api/layers/${newLayer.id}/elements`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${user.token}`,
            },
            body: JSON.stringify({
              text: el.text,
              font: el.font,
              size: el.size,
              autoSize: el.autoSize,
              maxWidth: el.maxWidth,
              maxHeight: el.maxHeight,
              wordWrap: el.wordWrap,
              rotation: el.rotation,
              x: el.x,
              y: el.y,
              visible: el.visible,
              backgroundColor: el.backgroundColor,
              textColor: el.textColor,
              fontWeight: el.fontWeight,
              fontStyle: el.fontStyle,
              boxShape: el.boxShape,
              maskPolygon: el.maskPolygon,
              regionId: el.regionId,
              // id intentionally omitted — fresh UUIDs, standalone copies
            }),
          },
        );
        if (cloneRes.ok) {
          const clonedEl: LayerElement = await cloneRes.json();
          clonedElements.push({
            ...clonedEl,
            isLayerElement: true,
          } as LayerElement);
        }
      }

      // Step 5: Hide source layer as a backup
      await safeFetch(`/api/layers/${sourceLayer.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({ visible: false }),
      });

      // Step 6: Refresh local UI state atomically
      setLayers((prev) => {
        // Enforce same sorted sequential ordering in UI state
        const currentSorted = [...prev].sort(
          (a, b) => a.layer.zOrder - b.layer.zOrder,
        );
        const updated = currentSorted.map((l, i) => {
          const targetZOrder = i > sourceIndex ? i + 1 : i;
          let visible = l.layer.visible;
          if (l.layer.id === sourceLayer.id) {
            visible = false; // Hide source layer
          }
          return { ...l, layer: { ...l.layer, zOrder: targetZOrder, visible } };
        });
        // Insert the new cloned layer, then sort by zOrder so the UI renders at the
        // correct position immediately (without needing a page refresh).
        updated.push({
          layer: { ...newLayer, isLayerElement: false } as unknown as Layer & {
            isLayerElement?: boolean;
          },
          elements: clonedElements,
        });
        return updated.sort((a, b) => a.layer.zOrder - b.layer.zOrder);
      });

      // Make the cloned layer active
      setActiveLayerId(newLayer.id);
    } catch (err) {
      console.error("Clone layer failed:", err);
      alert("Error cloning layer. Please try again.");
    }
  };

  // --- EXPORT HANDLERS ---
  const handleExportPng = useCallback(() => {
    if (!selectedPage || !imgRef.current) return;

    const doExport = () => {
      const img = imgRef.current!;
      const W = imageDims.w;
      const H = imageDims.h;

      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Draw the base page image
      ctx.drawImage(img, 0, 0, W, H);

      const hasTranslation = layers.some(
        (ld) => ld.layer.type === "translation",
      );
      // Draw visible layer elements
      sortedLayers.forEach((lData) => {
        const isOcrHidden =
          cleanScanlationView &&
          hasTranslation &&
          lData.layer.type === "ocr" &&
          !manuallyShownOcrLayers.has(lData.layer.id);
        if (!lData.layer.visible || isOcrHidden) return;
        lData.elements.forEach((el) => {
          if (!el.visible) return;
          const width = el.maxWidth || 100;
          const height = el.maxHeight || 100;

          ctx.save();
          if (!el.maskPolygon) {
            // Apply rotation around element center only if not absolute maskPolygon
            const cx = el.x + width / 2;
            const cy = el.y + height / 2;
            ctx.translate(cx, cy);
            ctx.rotate(((el.rotation || 0) * Math.PI) / 180);
            ctx.translate(-cx, -cy);
          }

          // Mask backdrop
          if (el.maskPolygon) {
            try {
              const pts = JSON.parse(el.maskPolygon);
              if (Array.isArray(pts) && pts.length > 0) {
                ctx.beginPath();
                const firstPt = pts.at(0);
                if (Array.isArray(firstPt)) {
                  ctx.moveTo(firstPt.at(0) ?? 0, firstPt.at(1) ?? 0);
                  for (let i = 1; i < pts.length; i++) {
                    const pt = pts.at(i);
                    if (Array.isArray(pt)) {
                      ctx.lineTo(pt.at(0) ?? 0, pt.at(1) ?? 0);
                    }
                  }
                }
                ctx.closePath();
                ctx.fillStyle = el.backgroundColor || "#ffffff";
                ctx.fill();
              }
            } catch (e) {
              console.error("Failed to draw canvas maskPolygon", e);
            }
          } else {
            ctx.fillStyle = el.backgroundColor || "#ffffff";
            if (el.boxShape === "elliptical") {
              ctx.beginPath();
              ctx.ellipse(
                el.x + width / 2,
                el.y + height / 2,
                width / 2,
                height / 2,
                0,
                0,
                2 * Math.PI,
              );
              ctx.fill();
            } else {
              ctx.fillRect(el.x, el.y, width, height);
            }
          }

          // Draw text
          let displayText = el.text || "";
          if (el.boxShape === "elliptical") {
            displayText = displayText.toUpperCase();
          }

          const fit = fitTextInBox(
            displayText,
            width - 8,
            height - 8,
            el.font || "Comic Neue",
            el.size || 16,
            el.boxShape === "elliptical" ? "elliptical" : "rectangular",
            el.x + 4,
            el.y + 4,
            el.maskPolygon,
            el.fontWeight || "bold",
            el.fontStyle || "normal",
          );
          const fSize = fit.fontSize;
          ctx.font = `${el.fontWeight || "bold"} ${el.fontStyle === "italic" ? "italic " : ""}${fSize}px "${el.font || "Comic Neue"}", sans-serif`;
          ctx.fillStyle = el.textColor || "#000000";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const lineH = fSize * 1.2;
          const startY =
            el.y + height / 2 - ((fit.lines.length - 1) * lineH) / 2;
          fit.lines.forEach((line, i) => {
            const lineCenterX =
              fit.lineCenters && fit.lineCenters.at(i) !== undefined
                ? (fit.lineCenters.at(i) ?? el.x + width / 2)
                : el.x + width / 2;
            ctx.fillText(line, lineCenterX, startY + i * lineH);
          });

          ctx.restore();
        });
      });

      // Trigger download
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `page-${selectedPage.pageNumber}-export.png`;
        a.click();
        URL.revokeObjectURL(url);
      }, "image/png");
    };

    if (dirtyElements.size > 0) {
      setConfirmModal({
        isOpen: true,
        title: "Unsaved Changes",
        message:
          "You have unsaved edits. Would you like to save them before exporting?",
        confirmText: "Save & Export",
        cancelText: "Export Anyway",
        isDangerous: false,
        onConfirm: async () => {
          closeConfirm();
          try {
            await saveAllPendingChanges();
            doExport();
          } catch (err) {
            console.error("Failed to save changes before export:", err);
          }
        },
        onCancel: () => {
          closeConfirm();
          doExport();
        },
      });
    } else {
      doExport();
    }
  }, [
    selectedPage,
    imageDims,
    layers,
    sortedLayers,
    cleanScanlationView,
    manuallyShownOcrLayers,
    dirtyElements,
    saveAllPendingChanges,
  ]);

  const handleExportZip = useCallback(async () => {
    if (!selectedPage || !imgRef.current) return;

    const doExport = async () => {
      const img = imgRef.current!;
      const W = imageDims.w;
      const H = imageDims.h;

      const zip = new JSZip();

      // 1. original.png
      const origCanvas = document.createElement("canvas");
      origCanvas.width = W;
      origCanvas.height = H;
      const origCtx = origCanvas.getContext("2d")!;
      origCtx.drawImage(img, 0, 0, W, H);
      const origBlob = await new Promise<Blob>((res) =>
        origCanvas.toBlob((b) => res(b!), "image/png"),
      );
      zip.file("original.png", origBlob);

      // 2. Render and save mask/translation image files for each layer
      for (const lData of layers) {
        const layerId = lData.layer.id;

        // Draw mask for this specific layer
        const maskCanvas = document.createElement("canvas");
        maskCanvas.width = W;
        maskCanvas.height = H;
        const maskCtx = maskCanvas.getContext("2d")!;

        lData.elements.forEach((el) => {
          if (!el.visible) return;
          const width = el.maxWidth || 100;
          const height = el.maxHeight || 100;

          if (el.maskPolygon) {
            try {
              const pts = JSON.parse(el.maskPolygon);
              if (Array.isArray(pts) && pts.length > 0) {
                maskCtx.save();
                maskCtx.beginPath();
                const firstPt = pts.at(0);
                if (Array.isArray(firstPt)) {
                  maskCtx.moveTo(firstPt.at(0) ?? 0, firstPt.at(1) ?? 0);
                  for (let j = 1; j < pts.length; j++) {
                    const pt = pts.at(j);
                    if (Array.isArray(pt)) {
                      maskCtx.lineTo(pt.at(0) ?? 0, pt.at(1) ?? 0);
                    }
                  }
                }
                maskCtx.closePath();
                maskCtx.fillStyle = el.backgroundColor || "#ffffff";
                maskCtx.fill();
                maskCtx.restore();
              }
            } catch (e) {
              console.error(
                "Failed to draw canvas maskPolygon in zip export",
                e,
              );
            }
          } else {
            maskCtx.save();
            const cx = el.x + width / 2;
            const cy = el.y + height / 2;
            maskCtx.translate(cx, cy);
            maskCtx.rotate(((el.rotation || 0) * Math.PI) / 180);
            maskCtx.translate(-cx, -cy);
            maskCtx.fillStyle = el.backgroundColor || "#ffffff";
            if (el.boxShape === "elliptical") {
              maskCtx.beginPath();
              maskCtx.ellipse(
                el.x + width / 2,
                el.y + height / 2,
                width / 2,
                height / 2,
                0,
                0,
                2 * Math.PI,
              );
              maskCtx.fill();
            } else {
              maskCtx.fillRect(el.x, el.y, width, height);
            }
            maskCtx.restore();
          }
        });

        const maskBlob = await new Promise<Blob>((res) =>
          maskCanvas.toBlob((b) => res(b!), "image/png"),
        );
        zip.file(`layer-${layerId}-mask.png`, maskBlob);

        // Draw translation/text for this specific layer
        const textCanvas = document.createElement("canvas");
        textCanvas.width = W;
        textCanvas.height = H;
        const textCtx = textCanvas.getContext("2d")!;

        lData.elements.forEach((el) => {
          if (!el.visible) return;
          const width = el.maxWidth || 100;
          const height = el.maxHeight || 100;
          let displayText = el.text || "";
          if (el.boxShape === "elliptical") {
            displayText = displayText.toUpperCase();
          }

          const fit = fitTextInBox(
            displayText,
            width - 8,
            height - 8,
            el.font || "Comic Neue",
            el.size || 16,
            el.boxShape === "elliptical" ? "elliptical" : "rectangular",
            el.x + 4,
            el.y + 4,
            el.maskPolygon,
            el.fontWeight || "bold",
            el.fontStyle || "normal",
          );
          const fSize = fit.fontSize;
          textCtx.save();
          if (!el.maskPolygon) {
            const cx = el.x + width / 2;
            const cy = el.y + height / 2;
            textCtx.translate(cx, cy);
            textCtx.rotate(((el.rotation || 0) * Math.PI) / 180);
            textCtx.translate(-cx, -cy);
          }
          textCtx.font = `${el.fontWeight || "bold"} ${el.fontStyle === "italic" ? "italic " : ""}${fSize}px "${el.font || "Comic Neue"}", sans-serif`;
          textCtx.fillStyle = el.textColor || "#000000";
          textCtx.textAlign = "center";
          textCtx.textBaseline = "middle";
          const lineH = fSize * 1.2;
          const startY =
            el.y + height / 2 - ((fit.lines.length - 1) * lineH) / 2;
          fit.lines.forEach((line, j) => {
            const lineCenterX =
              fit.lineCenters && fit.lineCenters.at(j) !== undefined
                ? (fit.lineCenters.at(j) ?? el.x + width / 2)
                : el.x + width / 2;
            textCtx.fillText(line, lineCenterX, startY + j * lineH);
          });
          textCtx.restore();
        });

        const textBlob = await new Promise<Blob>((res) =>
          textCanvas.toBlob((b) => res(b!), "image/png"),
        );
        zip.file(`layer-${layerId}-translation.png`, textBlob);
      }

      // 4. project.json
      const projectData = {
        pageNumber: selectedPage.pageNumber,
        imageId: selectedPage.imageId,
        dimensions: { width: W, height: H },
        exportedAt: new Date().toISOString(),
        layers: layers.map((lData) => ({
          id: lData.layer.id,
          type: lData.layer.type,
          targetLanguage: lData.layer.targetLanguage,
          visible: lData.layer.visible,
          zOrder: lData.layer.zOrder,
          metadataJson: lData.layer.metadataJson,
          elements: lData.elements.map((el) => ({
            id: el.id,
            text: el.text,
            font: el.font || "Comic Neue",
            size: el.size,
            autoSize: el.autoSize,
            x: el.x,
            y: el.y,
            maxWidth: el.maxWidth,
            maxHeight: el.maxHeight,
            rotation: el.rotation,
            visible: el.visible,
            wordWrap: el.wordWrap,
            backgroundColor: el.backgroundColor,
            textColor: el.textColor,
            fontWeight: el.fontWeight || "normal",
            fontStyle: el.fontStyle || "normal",
            boxShape: el.boxShape || "rectangular",
            maskPolygon: el.maskPolygon,
            regionId: el.regionId,
          })),
        })),
      };
      zip.file("project.json", JSON.stringify(projectData, null, 2));

      // Generate and download zip
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `page-${selectedPage.pageNumber}-layers.zip`;
      a.click();
      URL.revokeObjectURL(url);
    };

    if (dirtyElements.size > 0) {
      setConfirmModal({
        isOpen: true,
        title: "Unsaved Changes",
        message:
          "You have unsaved edits. Would you like to save them before exporting?",
        confirmText: "Save & Export",
        cancelText: "Export Anyway",
        isDangerous: false,
        onConfirm: async () => {
          closeConfirm();
          try {
            await saveAllPendingChanges();
            await doExport();
          } catch (err) {
            console.error("Failed to save changes before export:", err);
          }
        },
        onCancel: async () => {
          closeConfirm();
          await doExport();
        },
      });
    } else {
      await doExport();
    }
  }, [selectedPage, imageDims, layers, dirtyElements, saveAllPendingChanges]);

  // --- STABLE NAVIGATOR CALLBACK ---
  const navigateToPage = useCallback(
    (num: number) => {
      if (num >= 1 && num <= pages.length && selectedChapter) {
        const slugPart = selectedChapter.title
          ? `${toSlug(selectedChapter.title)}/`
          : `chapter-${selectedChapter.chapterNumber}/`;
        navigate(`/chapters/${selectedChapter.id}/${slugPart}reader/${num}`);
      }
    },
    [pages, selectedChapter, navigate],
  );

  // --- KEYBOARD WRITER EFFECT ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      if (e.key === "ArrowRight" || e.key.toLowerCase() === "d") {
        navigateToPage(curPageNum + 1);
      } else if (e.key === "ArrowLeft" || e.key.toLowerCase() === "a") {
        navigateToPage(curPageNum - 1);
      } else if (e.key === "Escape") {
        setSelectedItem(null);
        setActiveRegion(null);
        setActiveItem(null);
        setPopoverOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [curPageNum, navigateToPage]);

  // --- PANNING / DRAGGING WORKSPACE ---
  const handleMouseDownCanvas = (e: React.MouseEvent) => {
    if (interactionMode !== "none") return;
    if (e.button !== 0) return; // Only left click
    if (draggedElement) return;
    if (
      (e.target as HTMLElement).closest(".svg-ocr-box") ||
      (e.target as HTMLElement).closest(".svg-conv-box") ||
      (e.target as HTMLElement).closest(".bubble-popover") ||
      (e.target as HTMLElement).closest(".floating-reader-toolbar") ||
      (e.target as HTMLElement).closest(".vertical-zoom-toolbar") ||
      (e.target as HTMLElement).closest(".delete-page-btn") ||
      (e.target as HTMLElement).closest(".reorder-controls")
    ) {
      return;
    }
    setIsDraggingCanvas(true);
    dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    initialTouchPos.current = { x: e.clientX, y: e.clientY };
    hasMoved.current = false;
  };

  const handleMouseMoveCanvas = (e: React.MouseEvent) => {
    if (!isDraggingCanvas) return;
    const dx = e.clientX - initialTouchPos.current.x;
    const dy = e.clientY - initialTouchPos.current.y;
    if (Math.sqrt(dx * dx + dy * dy) > 10) {
      hasMoved.current = true;
    }
    setPan({
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y,
    });
  };

  const handleMouseUpCanvas = () => {
    setIsDraggingCanvas(false);
  };

  // --- TOUCH HANDLERS FOR TOUCH SCREENS ---
  const handleTouchStart = (e: React.TouchEvent) => {
    if (!isTouchScreen) return;

    // Ignore touch if inside interactive components
    const target = e.target as HTMLElement;
    if (
      target.closest(".svg-ocr-box") ||
      target.closest(".svg-conv-box") ||
      target.closest(".bubble-popover") ||
      target.closest(".floating-reader-toolbar") ||
      target.closest(".vertical-zoom-toolbar") ||
      target.closest(".delete-page-btn") ||
      target.closest(".reorder-controls")
    ) {
      return;
    }

    if (e.touches.length === 2) {
      // Pinch zoom start
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchStartDist.current = Math.sqrt(dx * dx + dy * dy);
      touchStartZoom.current = zoom;
      setIsDraggingCanvas(false);
    } else if (e.touches.length === 1) {
      // Single finger pan start
      setIsDraggingCanvas(true);
      dragStart.current = {
        x: e.touches[0].clientX - pan.x,
        y: e.touches[0].clientY - pan.y,
      };
      initialTouchPos.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
      };
      hasMoved.current = false;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isTouchScreen) return;

    if (e.touches.length === 2 && touchStartDist.current !== null) {
      // Pinch zoom logic
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (touchStartDist.current > 0) {
        const factor = dist / touchStartDist.current;
        const newZoom = touchStartZoom.current * factor;
        // Restrict zoom between 0.5 and 3.0
        setZoom(Math.max(0.5, Math.min(3.0, newZoom)));
      }
    } else if (e.touches.length === 1 && isDraggingCanvas) {
      // Single finger pan logic
      const dx = e.touches[0].clientX - initialTouchPos.current.x;
      const dy = e.touches[0].clientY - initialTouchPos.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > 10) {
        hasMoved.current = true;
      }
      setPan({
        x: e.touches[0].clientX - dragStart.current.x,
        y: e.touches[0].clientY - dragStart.current.y,
      });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!isTouchScreen) return;
    if (e.touches.length < 2) {
      touchStartDist.current = null;
    }
    if (e.touches.length === 0) {
      setIsDraggingCanvas(false);
    }
  };

  const handleCanvasAreaClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isTouchScreen) return;
    if (hasMoved.current) return; // Ignore clicks that were drags

    const target = e.target as HTMLElement;
    if (
      target.closest(".manga-canvas-wrapper") ||
      target.closest(".vertical-zoom-toolbar") ||
      target.closest(".reader-sidebar-nhentai") ||
      target.closest(".reader-navbar-nhentai") ||
      target.closest(".reader-footer-nhentai")
    ) {
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const isLeftHalf = clickX < rect.width / 2;

    if (isLeftHalf) {
      navigateToPage(curPageNum - 1);
    } else {
      navigateToPage(curPageNum + 1);
    }
  };

  // --- HOVER POPUP HANDLERS ---
  const handleMouseEnterItem = useCallback(
    (item: RenderItem) => {
      if (hideTimeout.current) clearTimeout(hideTimeout.current);
      setActiveItem(item);
      setActiveRegion(item.regions[0] || null);
      setPopoverOpen(true);
      setEditText(getCombinedText(item, showTranslations));
    },
    [showTranslations, getCombinedText],
  );

  const handleMouseLeaveItem = useCallback(() => {
    hideTimeout.current = setTimeout(() => {
      setPopoverOpen(false);
      setIsEditingRegion(false);
    }, 300);
  }, []);

  const handleMouseEnterPopover = useCallback(() => {
    if (hideTimeout.current) clearTimeout(hideTimeout.current);
  }, []);

  const handleMouseLeavePopover = useCallback(() => {
    setPopoverOpen(false);
    setIsEditingRegion(false);
  }, []);

  // --- BUBBLE/CONVERSATION UPDATES ---
  const handleToggleApprove = async (item: RenderItem) => {
    const AegeanApproved = !item.approved;

    // Optimistically update locally
    setOcrRegions((prev) =>
      prev.map((r) => {
        if (item.regions.some((reg: OcrRegion) => reg.id === r.id)) {
          return { ...r, approved: AegeanApproved };
        }
        return r;
      }),
    );

    if (activeItem && activeItem.id === item.id) {
      setActiveItem((prev: RenderItem | null) =>
        prev ? { ...prev, approved: AegeanApproved } : null,
      );
    }

    const promises = item.regions.map(async (region: OcrRegion) => {
      try {
        const res = await safeFetch(`/api/ocr-regions/${region.id}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${user.token}`,
          },
          body: JSON.stringify({ approved: AegeanApproved }),
        });
        if (!res.ok) {
          throw new Error("Failed to update approval on server");
        }
      } catch (err) {
        console.error("Error updating approval status:", err);
      }
    });

    await Promise.all(promises);

    // Refresh conversations state from backend
    if (selectedPage) {
      safeFetch(`/api/images/${selectedPage.imageId}`, {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((res) => res.json())
        .then((data) => {
          setConversations(data.conversations || []);
        })
        .catch((err) => console.error(err));
    }
  };

  const handleSaveEdit = async () => {
    if (!activeItem) return;

    const lines = editText.split("\n");
    const promises = activeItem.regions.map(
      async (region: OcrRegion, idx: number) => {
        const newText =
          lines.at(idx) !== undefined ? (lines.at(idx) ?? "") : "";

        setOcrRegions((prev) =>
          prev.map((r) => {
            if (r.id === region.id) {
              return {
                ...r,
                ...(showTranslations
                  ? { translatedText: newText }
                  : { text: newText }),
              };
            }
            return r;
          }),
        );

        const body: { text?: string; translatedText?: string } = {};
        if (showTranslations) {
          body.translatedText = newText;
        } else {
          body.text = newText;
        }

        try {
          const res = await safeFetch(`/api/ocr-regions/${region.id}`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${user.token}`,
            },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            throw new Error("Failed to save edit on server");
          }
        } catch (err) {
          console.error("Error saving region edit:", err);
          throw err;
        }
      },
    );

    setIsEditingRegion(false);
    const results = await Promise.allSettled(promises);
    const hasErrors = results.some((r) => r.status === "rejected");
    if (hasErrors) {
      showError("Error saving region edit.", {
        action: { label: "Retry", onClick: () => handleSaveEdit() },
      });
    } else {
      showSuccess("Saved text changes!");
    }

    // Refresh conversations state from backend
    if (selectedPage) {
      safeFetch(`/api/images/${selectedPage.imageId}`, {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((res) => res.json())
        .then((data) => {
          setConversations(data.conversations || []);
        })
        .catch((err) => console.error(err));
    }
  };

  const handleRedoRegion = async (
    r: OcrRegion,
    forceType?: "ocr" | "translation",
  ) => {
    setIsRedoing(true);
    const type = forceType || (showTranslations ? "translation" : "ocr");

    try {
      const res = await safeFetch(
        `/api/ocr-regions/${r.id}/redo?type=${type}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${user.token}`,
          },
        },
      );

      if (!res.ok) {
        throw new Error("Redo request failed");
      }

      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        if (attempts > 20) {
          clearInterval(interval);
          setIsRedoing(false);
          showInfo(
            "Redo Timed Out",
            "The redo operation timed out. Please try again.",
            "error",
          );
          return;
        }

        try {
          const checkRes = await safeFetch(
            `/api/images/${selectedPage?.imageId}`,
            {
              headers: { Authorization: `Bearer ${user.token}` },
            },
          );
          if (checkRes.ok) {
            const data = await checkRes.json();
            const regions: OcrRegion[] = data.ocrRegions || [];
            const freshRegion = regions.find((item) => item.id === r.id);
            if (freshRegion) {
              const textChanged =
                type === "translation"
                  ? freshRegion.translatedText !== r.translatedText
                  : freshRegion.text !== r.text;

              if (textChanged || attempts >= 8) {
                clearInterval(interval);
                setOcrRegions(regions);
                setConversations(data.conversations || []);
                if (activeRegion && activeRegion.id === r.id) {
                  setActiveRegion(freshRegion);
                  setActiveItem((prev: RenderItem | null) => {
                    if (!prev) return null;
                    return {
                      ...prev,
                      regions: prev.regions.map((reg: OcrRegion) =>
                        reg.id === r.id ? freshRegion : reg,
                      ),
                    };
                  });
                  setEditText(
                    showTranslations
                      ? freshRegion.translatedText || ""
                      : freshRegion.text,
                  );
                }
                setIsRedoing(false);
              }
            }
          }
        } catch (pollErr) {
          console.error("Polling error during redo:", pollErr);
        }
      }, 500);
    } catch (err) {
      console.error("Error redoing region:", err);
      setIsRedoing(false);
      showInfo("Redo Failed", "Failed to start redo job.", "error");
    }
  };

  const handleRedoPageOcr = async () => {
    if (!selectedPage) return;
    setIsRedoingPageOcr(true);
    try {
      const res = await safeFetch(
        `/api/images/${selectedPage.imageId}/redo?type=ocr`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${user.token}` },
        },
      );
      if (res.ok) {
        showInfo(
          "Job Enqueued",
          "Page OCR & Translation redo job enqueued successfully.",
          "success",
        );
      } else {
        showInfo(
          "Enqueue Failed",
          "Failed to enqueue Page OCR redo job.",
          "error",
        );
      }
    } catch (err) {
      console.error(err);
      showInfo(
        "Error",
        "An error occurred while triggering the redo job.",
        "error",
      );
    } finally {
      setIsRedoingPageOcr(false);
    }
  };

  const handleRedoPageTranslation = async () => {
    if (!selectedPage) return;
    setIsRedoingPageTranslation(true);
    try {
      const res = await safeFetch(
        `/api/images/${selectedPage.imageId}/redo?type=translation`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${user.token}` },
        },
      );
      if (res.ok) {
        showInfo(
          "Job Enqueued",
          "Page Translation redo job enqueued successfully.",
          "success",
        );
      } else {
        showInfo(
          "Enqueue Failed",
          "Failed to enqueue Page Translation redo job.",
          "error",
        );
      }
    } catch (err) {
      console.error(err);
      showInfo(
        "Error",
        "An error occurred while triggering the redo job.",
        "error",
      );
    } finally {
      setIsRedoingPageTranslation(false);
    }
  };

  const handleImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setImageDims({
      w: e.currentTarget.naturalWidth,
      h: e.currentTarget.naturalHeight,
    });
  };

  if (isLoadingPageDetails || !selectedPage) {
    return (
      <div
        className="reader-container-nhentai"
        style={{ alignItems: "center", justifyContent: "center" }}
      >
        <div className="spinner"></div>
        <p>Loading page details...</p>
      </div>
    );
  }

  return (
    <div className="reader-container-nhentai">
      {/* Top Navbar */}
      <div
        className="reader-navbar-nhentai"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button
            className="reader-nav-btn back-btn"
            onClick={() =>
              navigate(
                `/chapters/${selectedChapter ? selectedChapter.id : ""}/${selectedChapter ? toSlug(selectedChapter.title || `chapter-${selectedChapter.chapterNumber}`) : ""}`,
              )
            }
            title="Back to Chapter"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line
                x1="19"
                y1="12"
                x2="5"
                y2="12"
              ></line>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
          </button>

          <button
            className={`reader-nav-btn gear-btn ${showLeftSidebar ? "active" : ""}`}
            onClick={() => setShowLeftSidebar((prev) => !prev)}
            title="Toggle Global Controls (Left Sidebar)"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <rect
                x="3"
                y="3"
                width="18"
                height="18"
                rx="2"
              />
              <line
                x1="9"
                y1="3"
                x2="9"
                y2="21"
              />
            </svg>
          </button>
        </div>

        <div
          style={{
            fontWeight: 600,
            fontSize: "14px",
            fontFamily: "var(--font-display)",
            color: "var(--text-main)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "50%",
          }}
        >
          {selectedSeries ? selectedSeries.title : "Series"} &mdash; Chapter{" "}
          {selectedChapter?.chapterNumber}
        </div>

        <button
          className={`reader-nav-btn gear-btn ${showRightSidebar ? "active" : ""}`}
          onClick={() => setShowRightSidebar((prev) => !prev)}
          title="Toggle Property Inspector (Right Sidebar)"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <rect
              x="3"
              y="3"
              width="18"
              height="18"
              rx="2"
            />
            <line
              x1="15"
              y1="3"
              x2="15"
              y2="21"
            />
          </svg>
        </button>
      </div>

      {/* Main Workspace split */}
      <div className="reader-workspace-frame-nhentai">
        {/* Left Sidebar (Global Controls) */}
        {showLeftSidebar && (
          <div className="reader-left-sidebar-nhentai">
            {/* Overlays Visibility Section */}
            <div className="panel-section">
              <div className="panel-section-title">Overlays</div>
              <div className="overlay-toggle">
                <span>Panel Boundaries</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={showPanels}
                    onChange={(e) => setShowPanels(e.target.checked)}
                  />
                  <span className="slider"></span>
                </label>
              </div>
              <div className="overlay-toggle">
                <span>OCR Boxes</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={showOcr}
                    onChange={(e) => setShowOcr(e.target.checked)}
                  />
                  <span className="slider"></span>
                </label>
              </div>
              <div className="overlay-toggle">
                <span>Clean Scanlation</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={cleanScanlationView}
                    onChange={(e) => {
                      setCleanScanlationView(e.target.checked);
                      setManuallyShownOcrLayers(new Set());
                    }}
                  />
                  <span className="slider"></span>
                </label>
              </div>
              <div className="overlay-toggle">
                <span>Group Conversation</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={groupByConversation}
                    onChange={(e) => setGroupByConversation(e.target.checked)}
                  />
                  <span className="slider"></span>
                </label>
              </div>
            </div>

            {/* Zoom Controls Section */}
            <div className="panel-section">
              <div className="panel-section-title">Zoom & View</div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  marginBottom: "8px",
                }}
              >
                <input
                  type="range"
                  min="0.5"
                  max="3.0"
                  step="0.1"
                  value={zoom}
                  onChange={(e) => setZoom(parseFloat(e.target.value))}
                  style={{ flex: 1 }}
                />
                <span
                  style={{
                    fontSize: "12px",
                    fontWeight: "bold",
                    minWidth: "40px",
                    textAlign: "right",
                  }}
                >
                  {displayedZoom}%
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: "6px",
                  width: "100%",
                  marginBottom: "8px",
                }}
              >
                <button
                  className={`btn ${fitMode === "page" ? "btn-primary" : "btn-secondary"}`}
                  style={{ flex: 1, fontSize: "10px", padding: "4px" }}
                  onClick={() => setFitMode("page")}
                >
                  Page
                </button>
                <button
                  className={`btn ${fitMode === "width" ? "btn-primary" : "btn-secondary"}`}
                  style={{ flex: 1, fontSize: "10px", padding: "4px" }}
                  onClick={() => setFitMode("width")}
                >
                  Width
                </button>
                <button
                  className={`btn ${fitMode === "height" ? "btn-primary" : "btn-secondary"}`}
                  style={{ flex: 1, fontSize: "10px", padding: "4px" }}
                  onClick={() => setFitMode("height")}
                >
                  Height
                </button>
              </div>
              <button
                className="btn btn-secondary"
                style={{ width: "100%", fontSize: "11px", padding: "6px" }}
                onClick={() => {
                  setZoom(1.0);
                  setFitMode("page");
                }}
                disabled={zoom === 1.0 && fitMode === "page"}
              >
                Reset Zoom
              </button>
            </div>

            {/* Page & Chapter Navigation */}
            <div className="panel-section">
              <div className="panel-section-title">Navigation</div>

              <div
                className="reader-page-controls-nhentai"
                style={{
                  display: "flex",
                  justifyContent: "center",
                  marginBottom: "12px",
                  gap: "6px",
                }}
              >
                <button
                  className="reader-control-btn"
                  onClick={() => navigateToPage(1)}
                  disabled={curPageNum <= 1}
                  title="First Page"
                >
                  &lt;&lt;
                </button>
                <button
                  className="reader-control-btn"
                  onClick={() => navigateToPage(curPageNum - 1)}
                  disabled={curPageNum <= 1}
                  title="Previous Page"
                >
                  &lt;
                </button>

                <span
                  className="reader-page-indicator-nhentai"
                  style={{ margin: "0 4px", fontSize: "12px" }}
                >
                  <strong>{curPageNum}</strong> / {totalPages}
                </span>

                <button
                  className="reader-control-btn"
                  onClick={() => navigateToPage(curPageNum + 1)}
                  disabled={curPageNum >= totalPages}
                  title="Next Page"
                >
                  &gt;
                </button>
                <button
                  className="reader-control-btn"
                  onClick={() => navigateToPage(totalPages)}
                  disabled={curPageNum >= totalPages}
                  title="Last Page"
                >
                  &gt;&gt;
                </button>
              </div>

              {/* Chapter Navigation */}
              <div style={{ display: "flex", gap: "8px", width: "100%" }}>
                <button
                  className="btn btn-secondary"
                  style={{ flex: 1, fontSize: "11px", padding: "6px" }}
                  onClick={() => prevChapter && navigateToChapter(prevChapter)}
                  disabled={!prevChapter}
                  title={
                    prevChapter
                      ? `Go to Chapter ${prevChapter.chapterNumber}`
                      : "No previous chapter"
                  }
                >
                  &larr; Prev Ch
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ flex: 1, fontSize: "11px", padding: "6px" }}
                  onClick={() => nextChapter && navigateToChapter(nextChapter)}
                  disabled={!nextChapter}
                  title={
                    nextChapter
                      ? `Go to Chapter ${nextChapter.chapterNumber}`
                      : "No next chapter"
                  }
                >
                  Next Ch &rarr;
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Center Canvas */}
        <div className="reader-main-nhentai">
          <div
            ref={canvasAreaRef}
            className="reader-canvas-area"
            onMouseDown={handleMouseDownCanvas}
            onMouseMove={handleMouseMoveCanvas}
            onMouseUp={handleMouseUpCanvas}
            onMouseLeave={handleMouseUpCanvas}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onClick={handleCanvasAreaClick}
            style={{
              overflow: "hidden",
              cursor: isDraggingCanvas ? "grabbing" : "grab",
              touchAction: isTouchScreen ? "none" : "auto",
            }}
          >
            <div
              className="manga-canvas-wrapper"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: "center center",
                position: "relative",
                transition: isDraggingCanvas
                  ? "none"
                  : "transform 0.15s ease-out",
                userSelect: "none",
              }}
            >
              <img
                ref={imgRef}
                src={selectedPage.url}
                alt={`Page ${selectedPage.pageNumber}`}
                className="reader-image"
                onLoad={handleImgLoad}
                style={{
                  width: fitMode === "width" ? "100%" : "auto",
                  height: fitMode === "height" ? "85vh" : "auto",
                  maxHeight: fitMode === "page" ? "80vh" : "none",
                  maxWidth: fitMode === "page" ? "100%" : "none",
                }}
                draggable={false}
              />
              <svg
                className="svg-overlay"
                viewBox={`0 0 ${imageDims.w} ${imageDims.h}`}
                style={{ pointerEvents: "auto" }}
              >
                {showPanels &&
                  !cleanScanlationView &&
                  panels.map((p) => (
                    <rect
                      key={p.id}
                      x={p.bboxX}
                      y={p.bboxY}
                      width={p.bboxW}
                      height={p.bboxH}
                      className="svg-panel-box"
                      style={{ pointerEvents: "none" }}
                    />
                  ))}

                {showOcr &&
                  !cleanScanlationView &&
                  renderItems.map((item) => {
                    const isSelected = selectedItem?.id === item.id;
                    const isApproved = item.approved;
                    const qaStatus = item.regions.find(
                      (r) =>
                        r.qaStatus === "failed" ||
                        r.qaStatus === "manual_review",
                    )
                      ? "failed"
                      : item.regions.find((r) => r.qaStatus === "direct_fix")
                        ? "direct_fix"
                        : item.regions.find((r) => r.qaStatus === "passed")
                          ? "passed"
                          : null;
                    return (
                      <g
                        key={item.id}
                        onClick={() => {
                          setSelectedItem(item);
                          setActiveItem(item);
                          setActiveRegion(item.regions[0] || null);
                          setPopoverOpen(true);
                          setEditText(getCombinedText(item, showTranslations));
                        }}
                        onMouseEnter={() => handleMouseEnterItem(item)}
                        onMouseLeave={handleMouseLeaveItem}
                        style={{
                          cursor: "pointer",
                          pointerEvents:
                            interactionMode !== "none" ? "none" : "auto",
                        }}
                      >
                        <rect
                          x={item.bboxX}
                          y={item.bboxY}
                          width={item.bboxW}
                          height={item.bboxH}
                          className={
                            item.isConversation ? "svg-conv-box" : "svg-ocr-box"
                          }
                          style={{
                            fill: isSelected
                              ? item.isConversation
                                ? "var(--conversation-glow-selected)"
                                : "var(--primary-glow-selected)"
                              : isApproved
                                ? item.isConversation
                                  ? "var(--conversation-glow-approved)"
                                  : "var(--primary-glow-approved)"
                                : item.isConversation
                                  ? "var(--conversation-glow)"
                                  : "var(--success-glow)",
                            stroke: isSelected
                              ? item.isConversation
                                ? "var(--conversation)"
                                : "var(--primary)"
                              : qaStatus === "failed"
                                ? "#ef4444"
                                : qaStatus === "direct_fix"
                                  ? "#f59e0b"
                                  : isApproved
                                    ? item.isConversation
                                      ? "var(--conversation)"
                                      : "var(--primary)"
                                    : item.isConversation
                                      ? "var(--conversation)"
                                      : "var(--success)",
                            strokeWidth:
                              isSelected || isApproved
                                ? 2.5
                                : qaStatus === "failed"
                                  ? 2.5
                                  : 1.5,
                            strokeDasharray:
                              !isSelected && qaStatus === "failed"
                                ? "4 2"
                                : undefined,
                          }}
                        />
                        <g
                          transform={`translate(${item.bboxX + 10}, ${item.bboxY + 10})`}
                        >
                          <circle
                            cx="0"
                            cy="0"
                            r="8"
                            fill={
                              isSelected
                                ? item.isConversation
                                  ? "var(--conversation)"
                                  : "var(--primary)"
                                : qaStatus === "failed"
                                  ? "#ef4444"
                                  : qaStatus === "direct_fix"
                                    ? "#f59e0b"
                                    : isApproved
                                      ? item.isConversation
                                        ? "var(--conversation)"
                                        : "var(--primary)"
                                      : item.isConversation
                                        ? "var(--conversation)"
                                        : "var(--success)"
                            }
                          />
                          <text
                            x="0"
                            y="0"
                            className="bubble-text-tag"
                            style={{
                              textAnchor: "middle",
                              dominantBaseline: "central",
                              fontSize: "9px",
                              fontWeight: "bold",
                              fill: "#ffffff",
                            }}
                          >
                            {isApproved
                              ? "✓"
                              : item.regions[0]?.bubbleReadingOrder || 1}
                          </text>
                        </g>
                      </g>
                    );
                  })}

                {sortedLayers.map((lData) => {
                  const hasTranslation = layers.some(
                    (ld) => ld.layer.type === "translation",
                  );
                  const isOcrHidden =
                    cleanScanlationView &&
                    hasTranslation &&
                    lData.layer.type === "ocr" &&
                    !manuallyShownOcrLayers.has(lData.layer.id);
                  if (!lData.layer.visible || isOcrHidden) return null;
                  return lData.elements.map((element) => {
                    if (!element.visible) return null;

                    const isSelected =
                      selectedItem?.id === element.id &&
                      selectedItem?.isLayerElement;

                    const relatedRegion = element.regionId
                      ? filteredOcrRegions.find(
                          (r) => r.id === element.regionId,
                        )
                      : null;
                    const elQaStatus = relatedRegion
                      ? relatedRegion.qaStatus
                      : null;

                    // Run text fitting
                    let fontSize: number;
                    let overflow: boolean;

                    const fit = fitTextInBox(
                      element.text || "",
                      element.maxWidth || 100,
                      element.maxHeight || 100,
                      element.font || "Comic Neue",
                      element.size || 16,
                      element.boxShape === "elliptical"
                        ? "elliptical"
                        : "rectangular",
                      element.x,
                      element.y,
                      element.maskPolygon,
                      element.fontWeight || "bold",
                      element.fontStyle || "normal",
                    );

                    if (element.autoSize) {
                      fontSize = fit.fontSize;
                      overflow = fit.overflow;
                    } else {
                      fontSize = element.size || 16;
                      const totalHeight = fit.lines.length * fontSize * 1.2;
                      overflow = totalHeight > (element.maxHeight || 100);
                    }
                    const textToRender = fit.lines.join("\n");

                    const width = element.maxWidth || 100;
                    const height = element.maxHeight || 100;
                    const cx = element.x + width / 2;
                    const cy = element.y + height / 2;

                    // Support masking toggle via wordWrap field
                    const isMaskEnabled =
                      cleanScanlationView || element.wordWrap;

                    return (
                      <g
                        key={element.id}
                        transform={
                          element.maskPolygon
                            ? undefined
                            : `rotate(${element.rotation || 0}, ${cx}, ${cy})`
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedItem({ ...element, isLayerElement: true });
                          setActiveLayerId(element.layerId);
                        }}
                        style={{ cursor: "pointer" }}
                      >
                        {/* Backdrop Mask */}
                        {isMaskEnabled &&
                          (element.maskPolygon ? (
                            (() => {
                              try {
                                const pts = JSON.parse(element.maskPolygon);
                                if (Array.isArray(pts) && pts.length > 0) {
                                  const pointsStr = pts
                                    .map((p) => `${p[0]},${p[1]}`)
                                    .join(" ");
                                  return (
                                    <polygon
                                      points={pointsStr}
                                      fill={
                                        element.backgroundColor || "#ffffff"
                                      }
                                      stroke="none"
                                    />
                                  );
                                }
                              } catch {
                                // Ignore parsing errors
                              }
                              return null;
                            })()
                          ) : element.boxShape === "elliptical" ? (
                            <ellipse
                              cx={cx}
                              cy={cy}
                              rx={width / 2}
                              ry={height / 2}
                              fill={element.backgroundColor || "#ffffff"}
                              stroke="none"
                            />
                          ) : (
                            <rect
                              x={element.x}
                              y={element.y}
                              width={width}
                              height={height}
                              fill={element.backgroundColor || "#ffffff"}
                              stroke="none"
                            />
                          ))}

                        {/* Developer/Editor borders */}
                        {!cleanScanlationView && (
                          <rect
                            x={element.x}
                            y={element.y}
                            width={width}
                            height={height}
                            fill="transparent"
                            stroke={
                              isSelected
                                ? "var(--primary)"
                                : elQaStatus === "failed" ||
                                    elQaStatus === "manual_review"
                                  ? "#ef4444"
                                  : elQaStatus === "direct_fix"
                                    ? "#f59e0b"
                                    : "rgba(139, 92, 246, 0.4)"
                            }
                            strokeWidth={
                              isSelected
                                ? 2
                                : elQaStatus === "failed" ||
                                    elQaStatus === "manual_review"
                                  ? 2
                                  : 1
                            }
                            strokeDasharray={
                              isSelected
                                ? "none"
                                : elQaStatus === "failed" ||
                                    elQaStatus === "manual_review"
                                  ? "none"
                                  : "4 4"
                            }
                          />
                        )}

                        {/* Interactive overlay rect for drag-to-position mode */}
                        {!cleanScanlationView && (
                          <rect
                            x={element.x}
                            y={element.y}
                            width={width}
                            height={height}
                            fill="white"
                            fillOpacity={0}
                            style={{
                              cursor:
                                interactionMode === "drag" && isSelected
                                  ? "move"
                                  : "pointer",
                              pointerEvents: "auto",
                              touchAction: "none",
                            }}
                            onPointerDown={(e) => {
                              if (interactionMode === "drag" && isSelected) {
                                handleElementDragStart(e, element);
                              }
                            }}
                          />
                        )}

                        {/* Warning/Overflow border in editor mode */}
                        {overflow && !cleanScanlationView && (
                          <rect
                            x={element.x - 2}
                            y={element.y - 2}
                            width={width + 4}
                            height={height + 4}
                            fill="white"
                            fillOpacity={0}
                            stroke="#ef4444"
                            strokeWidth="1.5"
                            strokeDasharray="2 2"
                            style={{ pointerEvents: "none" }}
                          />
                        )}

                        {/* Vertex + Rotation Handles (Reshape Mode) */}
                        {isSelected &&
                          interactionMode === "reshape" &&
                          !cleanScanlationView &&
                          (() => {
                            const currentPolygon: Polygon | null = (() => {
                              if (!element.maskPolygon) return null;
                              try {
                                return JSON.parse(
                                  element.maskPolygon,
                                ) as Polygon;
                              } catch {
                                return null;
                              }
                            })();
                            if (!currentPolygon || currentPolygon.length < 3)
                              return null;

                            const centroid = polygonCentroid(currentPolygon);
                            const bbox = polygonBBox(currentPolygon);
                            // Rotation handle sits 32px above the bbox top, at centroid X
                            const rotHandleX = centroid[0];
                            const rotHandleY = Math.max(10, bbox.y - 32);
                            const vertexRadius = isTouchScreen ? 10 : 7;

                            return (
                              <>
                                {/* Dashed polygon outline */}
                                <polygon
                                  points={currentPolygon
                                    .map((p) => `${p[0]},${p[1]}`)
                                    .join(" ")}
                                  fill="none"
                                  stroke="var(--primary)"
                                  strokeWidth={2}
                                  strokeDasharray="6 3"
                                  style={{ pointerEvents: "none" }}
                                />

                                {/* Vertex handles */}
                                {currentPolygon.map(([px, py], vi) => (
                                  <circle
                                    key={`vtx-${vi}`}
                                    cx={px}
                                    cy={py}
                                    r={vertexRadius}
                                    fill="var(--primary)"
                                    stroke="#ffffff"
                                    strokeWidth={2}
                                    style={{
                                      cursor: "grab",
                                      pointerEvents: "auto",
                                      touchAction: "none",
                                    }}
                                    onPointerDown={(e) =>
                                      handleVertexDragStart(
                                        e,
                                        element,
                                        vi,
                                        currentPolygon,
                                      )
                                    }
                                  />
                                ))}

                                {/* Stem line to rotation handle */}
                                <line
                                  x1={centroid[0]}
                                  y1={bbox.y}
                                  x2={rotHandleX}
                                  y2={rotHandleY}
                                  stroke="var(--primary)"
                                  strokeWidth={1.5}
                                  strokeDasharray="3 2"
                                  style={{ pointerEvents: "none" }}
                                />

                                {/* Rotation handle circle */}
                                <circle
                                  cx={rotHandleX}
                                  cy={rotHandleY}
                                  r={isTouchScreen ? 12 : 9}
                                  fill="var(--primary)"
                                  stroke="#ffffff"
                                  strokeWidth={2}
                                  style={{
                                    cursor: "grab",
                                    pointerEvents: "auto",
                                    touchAction: "none",
                                  }}
                                  onPointerDown={(e) =>
                                    handleRotationDragStart(
                                      e,
                                      element,
                                      currentPolygon,
                                    )
                                  }
                                />
                                {/* Rotation icon (arc arrow) */}
                                <path
                                  d={`M${rotHandleX - 4},${rotHandleY - 1} A4,4 0 1,1 ${rotHandleX + 4},${rotHandleY - 1}`}
                                  fill="none"
                                  stroke="#ffffff"
                                  strokeWidth={1.5}
                                  strokeLinecap="round"
                                  style={{ pointerEvents: "none" }}
                                />
                                <path
                                  d={`M${rotHandleX + 2},${rotHandleY - 3} L${rotHandleX + 5},${rotHandleY - 1}`}
                                  fill="none"
                                  stroke="#ffffff"
                                  strokeWidth={1.5}
                                  strokeLinecap="round"
                                  style={{ pointerEvents: "none" }}
                                />
                              </>
                            );
                          })()}

                        <foreignObject
                          x={element.x}
                          y={element.y}
                          width={width}
                          height={height}
                          style={{ pointerEvents: "none" }}
                        >
                          <div
                            style={{
                              width: "100%",
                              height: "100%",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              textAlign: "center",
                              padding: "4px",
                              boxSizing: "border-box",
                              overflow: "hidden",
                            }}
                          >
                            {element.maskPolygon ? (
                              <div
                                style={{
                                  position: "relative",
                                  width: "100%",
                                  height: "100%",
                                }}
                              >
                                {fit.lines.map((line, i) => {
                                  const lineCenterX =
                                    fit.lineCenters &&
                                    fit.lineCenters.at(i) !== undefined
                                      ? (fit.lineCenters.at(i) ??
                                        element.x + width / 2)
                                      : element.x + width / 2;
                                  const lineH = fontSize * 1.2;
                                  const startY =
                                    element.y +
                                    height / 2 -
                                    ((fit.lines.length - 1) * lineH) / 2;
                                  const lineY = startY + i * lineH;

                                  return (
                                    <div
                                      key={i}
                                      style={{
                                        position: "absolute",
                                        left: `${lineCenterX - element.x}px`,
                                        top: `${lineY - element.y}px`,
                                        transform: "translate(-50%, -50%)",
                                        fontFamily: `"${element.font || "Comic Neue"}", sans-serif`,
                                        fontSize: `${fontSize}px`,
                                        fontWeight:
                                          element.fontWeight || "normal",
                                        fontStyle:
                                          element.fontStyle || "normal",
                                        color: element.textColor || "#000000",
                                        lineHeight: "1.2",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {line}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <div
                                style={{
                                  fontFamily: `"${element.font || "Comic Neue"}", sans-serif`,
                                  fontSize: `${fontSize}px`,
                                  fontWeight: element.fontWeight || "normal",
                                  fontStyle: element.fontStyle || "normal",
                                  color: element.textColor || "#000000",
                                  lineHeight: "1.2",
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                  textAlign: "center",
                                  width: "100%",
                                }}
                              >
                                {textToRender}
                              </div>
                            )}
                          </div>
                        </foreignObject>
                      </g>
                    );
                  });
                })}
              </svg>

              {/* Popover overlay tooltip */}
              {popoverOpen &&
                activeItem &&
                (() => {
                  const showBelow = activeItem.bboxY < 150;
                  const popoverWidth = 240;
                  const halfWidth = popoverWidth / 2;
                  const clampedX =
                    imageDims.w > popoverWidth
                      ? Math.max(
                          halfWidth,
                          Math.min(
                            imageDims.w - halfWidth,
                            activeItem.bboxX + activeItem.bboxW / 2,
                          ),
                        )
                      : imageDims.w / 2;
                  return (
                    <div
                      className="bubble-popover glass"
                      onMouseEnter={handleMouseEnterPopover}
                      onMouseLeave={handleMouseLeavePopover}
                      style={{
                        position: "absolute",
                        left: `${(clampedX / imageDims.w) * 100}%`,
                        top: showBelow
                          ? `${((activeItem.bboxY + activeItem.bboxH) / imageDims.h) * 100}%`
                          : `${(activeItem.bboxY / imageDims.h) * 100}%`,
                        transform: `${showBelow ? "translate(-50%, 0%)" : "translate(-50%, -100%)"} scale(${1 / zoom})`,
                        transformOrigin: showBelow
                          ? "top center"
                          : "bottom center",
                        marginTop: showBelow ? "12px" : "-12px",
                        zIndex: 100,
                        padding: "12px",
                        width: "240px",
                        borderRadius: "8px",
                        boxShadow:
                          "0 10px 15px -3px rgba(0,0,0,0.15), 0 4px 6px -2px rgba(0,0,0,0.05)",
                        border: "1px solid var(--border-color)",
                        backgroundColor: "var(--bg-surface)",
                        color: "var(--text-main)",
                        fontSize: "13px",
                        pointerEvents: "auto",
                      }}
                    >
                      {isRedoing ? (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            gap: "8px",
                            padding: "12px 0",
                          }}
                        >
                          <div
                            className="spinner"
                            style={{
                              width: "24px",
                              height: "24px",
                              margin: "0 auto",
                            }}
                          ></div>
                          <span
                            style={{
                              fontSize: "11px",
                              color: "var(--text-muted)",
                            }}
                          >
                            Running Redo Job...
                          </span>
                        </div>
                      ) : isEditingRegion ? (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "8px",
                          }}
                        >
                          <textarea
                            style={{
                              width: "100%",
                              minHeight: "80px",
                              backgroundColor:
                                "var(--bg-input, rgba(0,0,0,0.05))",
                              border: "1px solid var(--primary)",
                              borderRadius: "4px",
                              color: "var(--text-main)",
                              padding: "6px",
                              fontSize: "13px",
                              resize: "vertical",
                              outline: "none",
                              fontFamily: "inherit",
                            }}
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            autoFocus
                          />
                          <div
                            style={{
                              display: "flex",
                              gap: "6px",
                              justifyContent: "flex-end",
                            }}
                          >
                            <button
                              className="btn btn-secondary"
                              style={{ padding: "4px 8px", fontSize: "11px" }}
                              onClick={() => setIsEditingRegion(false)}
                            >
                              Cancel
                            </button>
                            <button
                              className="btn btn-primary"
                              style={{ padding: "4px 8px", fontSize: "11px" }}
                              onClick={handleSaveEdit}
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "8px",
                          }}
                        >
                          <div
                            style={{
                              wordBreak: "break-word",
                              lineHeight: "1.4",
                              maxHeight: "120px",
                              overflowY: "auto",
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            {showTranslations
                              ? getCombinedText(activeItem, true) ||
                                "No translation yet."
                              : getCombinedText(activeItem, false)}
                          </div>

                          {activeItem.regions[0]?.qaStatus && (
                            <div
                              style={{
                                marginTop: "4px",
                                padding: "8px",
                                borderRadius: "4px",
                                border: "1px solid var(--border-color)",
                                backgroundColor: "rgba(255, 255, 255, 0.03)",
                                fontSize: "11px",
                                lineHeight: "1.3",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  marginBottom: "4px",
                                }}
                              >
                                <span
                                  style={{
                                    fontWeight: "600",
                                    color: "var(--text-dim)",
                                  }}
                                >
                                  VLM QA Status
                                </span>
                                <span
                                  style={{
                                    textTransform: "uppercase",
                                    fontWeight: "700",
                                    padding: "2px 6px",
                                    borderRadius: "3px",
                                    fontSize: "9px",
                                    color: "#fff",
                                    backgroundColor:
                                      activeItem.regions[0].qaStatus ===
                                      "passed"
                                        ? "rgba(46, 204, 113, 0.85)" // Green for passed
                                        : activeItem.regions[0].qaStatus ===
                                            "failed"
                                          ? "rgba(231, 76, 60, 0.85)" // Red for failed
                                          : "rgba(230, 126, 34, 0.85)", // Orange/yellow for direct_fix
                                  }}
                                >
                                  {activeItem.regions[0].qaStatus.replace(
                                    "_",
                                    " ",
                                  )}
                                </span>
                              </div>
                              {activeItem.regions[0].qaScore !== undefined &&
                                activeItem.regions[0].qaScore !== null && (
                                  <div
                                    style={{
                                      color: "var(--text-muted)",
                                      marginBottom: "4px",
                                      fontSize: "10px",
                                    }}
                                  >
                                    Confidence Score:{" "}
                                    {(
                                      activeItem.regions[0].qaScore * 100
                                    ).toFixed(0)}
                                    %
                                  </div>
                                )}
                              {activeItem.regions[0].qaFeedback && (
                                <div
                                  style={{
                                    color: "var(--text-main)",
                                    fontStyle: "italic",
                                    wordBreak: "break-word",
                                    marginTop: "4px",
                                  }}
                                >
                                  "{activeItem.regions[0].qaFeedback}"
                                </div>
                              )}
                            </div>
                          )}

                          <div
                            style={{
                              borderTop: "1px solid var(--border-color)",
                              paddingTop: "8px",
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                            }}
                          >
                            <span
                              style={{
                                fontSize: "11px",
                                color: "var(--text-dim)",
                              }}
                            >
                              {showTranslations ? "Translated" : "Original"} (
                              {activeItem.regions[0]?.detectedLanguage})
                            </span>
                            <div style={{ display: "flex", gap: "10px" }}>
                              <button
                                onClick={() => handleToggleApprove(activeItem)}
                                style={{
                                  background: "none",
                                  border: "none",
                                  cursor: "pointer",
                                  color: activeItem.approved
                                    ? "var(--primary)"
                                    : "var(--text-dim)",
                                  padding: "2px",
                                  display: "flex",
                                  alignItems: "center",
                                }}
                                title={
                                  activeItem.approved ? "Approved" : "Approve"
                                }
                              >
                                <svg
                                  width="15"
                                  height="15"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="3"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <polyline points="20 6 9 17 4 12"></polyline>
                                </svg>
                              </button>

                              <button
                                onClick={() => {
                                  setIsEditingRegion(true);
                                  setEditText(
                                    getCombinedText(
                                      activeItem,
                                      showTranslations,
                                    ),
                                  );
                                }}
                                style={{
                                  background: "none",
                                  border: "none",
                                  cursor: "pointer",
                                  color: "var(--text-dim)",
                                  padding: "2px",
                                  display: "flex",
                                  alignItems: "center",
                                }}
                                title="Edit text"
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                  <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                                </svg>
                              </button>

                              {activeRegion && (
                                <>
                                  <button
                                    onClick={() =>
                                      handleRedoRegion(activeRegion, "ocr")
                                    }
                                    style={{
                                      background: "none",
                                      border: "none",
                                      cursor: "pointer",
                                      color: "var(--text-dim)",
                                      padding: "2px",
                                      display: "flex",
                                      alignItems: "center",
                                    }}
                                    title="Re-run OCR"
                                  >
                                    <svg
                                      width="14"
                                      height="14"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2.5"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                                    </svg>
                                  </button>

                                  <button
                                    onClick={() =>
                                      handleRedoRegion(
                                        activeRegion,
                                        "translation",
                                      )
                                    }
                                    style={{
                                      background: "none",
                                      border: "none",
                                      cursor: "pointer",
                                      color: "var(--text-dim)",
                                      padding: "2px",
                                      display: "flex",
                                      alignItems: "center",
                                    }}
                                    title="Re-translate text"
                                  >
                                    <svg
                                      width="14"
                                      height="14"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <path d="M2 5h12M7 2v3M7 5c0 4.4-3.6 8-8 8M5 9c-.9 2.3-2.9 4-5 4M14 18h8M18 11l4 10M18 11l-4 10" />
                                    </svg>
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
            </div>
          </div>
        </div>

        {/* Right Sidebar (Property Inspector) */}
        {showRightSidebar && (
          <div className="reader-right-sidebar-nhentai">
            {!selectedItem && (
              <>
                <div
                  style={{
                    color: "var(--text-muted)",
                    fontSize: "13px",
                    textAlign: "center",
                    padding: "16px 0 24px",
                    borderBottom: "1px solid var(--border-color)",
                    marginBottom: "24px",
                  }}
                >
                  Select an OCR region or a text layer to inspect and edit
                  details.
                </div>

                {/* Translation Layers Section */}
                <div className="panel-section">
                  <div
                    className="panel-section-title"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span>Layers</span>
                    <div
                      style={{
                        display: "flex",
                        gap: "4px",
                        alignItems: "center",
                      }}
                    >
                      {/* Up/Down reorder buttons — left group */}
                      <button
                        className="btn btn-secondary"
                        title="Move active layer up (higher in stack)"
                        disabled={
                          !activeLayerId ||
                          sortedLayers.findIndex(
                            (l) => l.layer.id === activeLayerId,
                          ) ===
                            sortedLayers.length - 1
                        }
                        onClick={() =>
                          activeLayerId && handleMoveLayer(activeLayerId, "up")
                        }
                        style={{
                          padding: "2px 6px",
                          fontSize: "12px",
                          opacity:
                            !activeLayerId ||
                            sortedLayers.findIndex(
                              (l) => l.layer.id === activeLayerId,
                            ) ===
                              sortedLayers.length - 1
                              ? 0.4
                              : 1,
                        }}
                      >
                        ↑
                      </button>
                      <button
                        className="btn btn-secondary"
                        title="Move active layer down (lower in stack)"
                        disabled={
                          !activeLayerId ||
                          sortedLayers.findIndex(
                            (l) => l.layer.id === activeLayerId,
                          ) === 0
                        }
                        onClick={() =>
                          activeLayerId &&
                          handleMoveLayer(activeLayerId, "down")
                        }
                        style={{
                          padding: "2px 6px",
                          fontSize: "12px",
                          opacity:
                            !activeLayerId ||
                            sortedLayers.findIndex(
                              (l) => l.layer.id === activeLayerId,
                            ) === 0
                              ? 0.4
                              : 1,
                        }}
                      >
                        ↓
                      </button>
                      {/* Divider */}
                      <div
                        style={{
                          width: "1px",
                          height: "14px",
                          background: "var(--border-color)",
                          margin: "0 2px",
                        }}
                      />
                      {/* Add layer buttons — right group */}
                      <button
                        className="btn btn-secondary"
                        style={{ padding: "2px 6px", fontSize: "10px" }}
                        onClick={handleCreateTranslationLayer}
                        title="Add Translation Layer"
                      >
                        + TL
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: "2px 6px", fontSize: "10px" }}
                        onClick={handleCreateSfxLayer}
                        title="Add SFX Layer"
                      >
                        + SFX
                      </button>
                    </div>
                  </div>

                  {sortedLayers.length === 0 ? (
                    <div
                      style={{
                        fontSize: "11px",
                        color: "var(--text-muted)",
                        padding: "4px 0",
                      }}
                    >
                      No active layers.
                    </div>
                  ) : (
                    [...sortedLayers].reverse().map((lData, idx) => {
                      const isActive = lData.layer.id === activeLayerId;
                      const stackNumber = sortedLayers.length - idx;
                      const stackLabel = `#${stackNumber}`;
                      return (
                        <div
                          key={lData.layer.id}
                          className="overlay-toggle"
                          onClick={() => setActiveLayerId(lData.layer.id)}
                          style={{
                            padding: "6px 8px",
                            border: isActive
                              ? "1px solid var(--primary)"
                              : "1px solid var(--border-color)",
                            borderRadius: "6px",
                            marginBottom: "6px",
                            backgroundColor: isActive
                              ? "var(--primary-glow)"
                              : "rgba(255,255,255,0.02)",
                            cursor: "pointer",
                            boxShadow: isActive
                              ? "0 0 8px var(--primary-glow)"
                              : "none",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "2px",
                            }}
                          >
                            <span
                              style={{
                                fontSize: "12px",
                                fontWeight: isActive ? 700 : 600,
                                color: isActive
                                  ? "var(--primary-hover)"
                                  : "inherit",
                              }}
                            >
                              {stackLabel}{" "}
                              {lData.layer.metadataJson?.layer_name ||
                                (lData.layer.type === "translation"
                                  ? `Translation (${lData.layer.targetLanguage?.toUpperCase() || "EN"})`
                                  : lData.layer.type === "sfx"
                                    ? "SFX Layer"
                                    : lData.layer.type === "ocr"
                                      ? "OCR Layer"
                                      : `Layer (${lData.layer.type})`)}
                            </span>
                            <span
                              style={{
                                fontSize: "9px",
                                color: "var(--text-dim)",
                              }}
                            >
                              {lData.elements.length} elements
                            </span>
                          </div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              onClick={() =>
                                handleToggleLayerVisibility(lData.layer.id)
                              }
                              style={{
                                background: "none",
                                border: "none",
                                color: lData.layer.visible
                                  ? "var(--primary)"
                                  : "var(--text-muted)",
                                cursor: "pointer",
                                padding: "2px",
                                display: "flex",
                                alignItems: "center",
                              }}
                              title="Toggle layer visibility"
                            >
                              {lData.layer.visible ? (
                                <svg
                                  width="15"
                                  height="15"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                >
                                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                                  <circle
                                    cx="12"
                                    cy="12"
                                    r="3"
                                  ></circle>
                                </svg>
                              ) : (
                                <svg
                                  width="15"
                                  height="15"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                >
                                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                                  <line
                                    x1="1"
                                    y1="1"
                                    x2="23"
                                    y2="23"
                                  ></line>
                                </svg>
                              )}
                            </button>

                            <button
                              onClick={() => handleCloneLayer(lData.layer.id)}
                              style={{
                                background: "none",
                                border: "none",
                                color: "var(--text-muted)",
                                cursor: "pointer",
                                padding: "2px",
                                display: "flex",
                                alignItems: "center",
                              }}
                              title="Clone layer (copies above, hides original as backup)"
                            >
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                              >
                                <rect
                                  x="9"
                                  y="9"
                                  width="13"
                                  height="13"
                                  rx="2"
                                  ry="2"
                                ></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                              </svg>
                            </button>

                            <button
                              onClick={() => handleDeleteLayer(lData.layer.id)}
                              style={{
                                background: "none",
                                border: "none",
                                color: "var(--text-muted)",
                                cursor: "pointer",
                                padding: "2px",
                                display: "flex",
                                alignItems: "center",
                              }}
                              title="Delete layer"
                            >
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                              >
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                              </svg>
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Editor Tools Section */}
                <div className="panel-section">
                  <div className="panel-section-title">Editor Tools</div>
                  <div
                    style={{ display: "flex", gap: "8px", marginBottom: "8px" }}
                  >
                    <button
                      className="btn btn-secondary"
                      style={{
                        flex: 1,
                        padding: "8px",
                        fontSize: "11px",
                        fontWeight: 600,
                      }}
                      onClick={() => handleAddNewElement("text")}
                      disabled={!activeLayerId}
                      title={
                        activeLayerId
                          ? "Add a new text element to active layer"
                          : "Select or create a layer first"
                      }
                    >
                      💬 Add Text
                    </button>
                    <button
                      className="btn btn-secondary"
                      style={{
                        flex: 1,
                        padding: "8px",
                        fontSize: "11px",
                        fontWeight: 600,
                      }}
                      onClick={() => handleAddNewElement("mask")}
                      disabled={!activeLayerId}
                      title={
                        activeLayerId
                          ? "Add a new background mask to active layer"
                          : "Select or create a layer first"
                      }
                    >
                      ⬜ Add Mask
                    </button>
                  </div>
                  <button
                    className="btn btn-secondary sidebar-action-btn"
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                    }}
                    onClick={handleLaunchEyeDropper}
                    disabled={!selectedItem || !selectedItem.isLayerElement}
                    title="Sample color from screen to apply to selected element's background"
                  >
                    🧪 Color Dropper
                  </button>
                </div>

                {/* Page Actions Section */}
                <div className="panel-section">
                  <div className="panel-section-title">Page Actions</div>
                  <button
                    className="btn btn-secondary sidebar-action-btn"
                    onClick={handleRedoPageOcr}
                    disabled={isRedoingPageOcr}
                    style={{
                      width: "100%",
                      marginBottom: "8px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                    }}
                  >
                    {isRedoingPageOcr ? (
                      <div className="spinner-mini"></div>
                    ) : null}
                    Redo Page OCR
                  </button>
                  <button
                    className="btn btn-secondary sidebar-action-btn"
                    onClick={handleRedoPageTranslation}
                    disabled={isRedoingPageTranslation}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                    }}
                  >
                    {isRedoingPageTranslation ? (
                      <div className="spinner-mini"></div>
                    ) : null}
                    Redo Page Translation
                  </button>
                </div>

                {/* Export Section */}
                <div
                  className="panel-section"
                  style={{ paddingBottom: "40px" }}
                >
                  <div className="panel-section-title">Export</div>
                  <button
                    className="btn btn-secondary sidebar-action-btn"
                    onClick={handleExportPng}
                    style={{
                      width: "100%",
                      marginBottom: "8px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                    }}
                  >
                    Export Page (PNG)
                  </button>
                  <button
                    className="btn btn-secondary sidebar-action-btn"
                    onClick={handleExportZip}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                    }}
                  >
                    Export Project (ZIP)
                  </button>
                </div>
              </>
            )}

            {selectedItem && selectedItem.isLayerElement && (
              <div
                className="ocr-detail-card"
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                <div
                  className="panel-section-title"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    margin: 0,
                  }}
                >
                  <span>Element Inspector</span>
                  <button
                    onClick={() => setSelectedItem(null)}
                    style={{
                      background: "transparent",
                      border: "1px solid var(--border-color)",
                      color: "var(--text-main)",
                      borderRadius: "6px",
                      padding: "4px 8px",
                      cursor: "pointer",
                      fontSize: "11px",
                      fontWeight: 600,
                    }}
                  >
                    Deselect
                  </button>
                </div>

                {/* Text Content */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <label
                    style={{
                      fontSize: "11px",
                      fontWeight: "bold",
                      color: "var(--text-muted)",
                    }}
                  >
                    Text Content
                  </label>
                  <textarea
                    style={{
                      width: "100%",
                      minHeight: "80px",
                      backgroundColor: "var(--bg-input, rgba(0,0,0,0.05))",
                      border: "1px solid var(--border-color)",
                      borderRadius: "4px",
                      color: "var(--text-main)",
                      padding: "6px",
                      fontSize: "13px",
                      resize: "vertical",
                      outline: "none",
                      fontFamily: "inherit",
                    }}
                    value={selectedItem.text || ""}
                    onChange={(e) =>
                      handleUpdateSelectedElement({ text: e.target.value })
                    }
                  />
                </div>

                {/* Positioning Coordinates Row */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "8px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <label
                      style={{
                        fontSize: "11px",
                        fontWeight: "bold",
                        color: "var(--text-muted)",
                      }}
                    >
                      X Position
                    </label>
                    <input
                      type="number"
                      className="form-input"
                      style={{ padding: "6px 10px", fontSize: "13px" }}
                      value={selectedItem.x}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          x: parseFloat(e.target.value) || 0,
                        })
                      }
                    />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <label
                      style={{
                        fontSize: "11px",
                        fontWeight: "bold",
                        color: "var(--text-muted)",
                      }}
                    >
                      Y Position
                    </label>
                    <input
                      type="number"
                      className="form-input"
                      style={{ padding: "6px 10px", fontSize: "13px" }}
                      value={selectedItem.y}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          y: parseFloat(e.target.value) || 0,
                        })
                      }
                    />
                  </div>
                </div>

                {/* Dimensions Row */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "8px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <label
                      style={{
                        fontSize: "11px",
                        fontWeight: "bold",
                        color: "var(--text-muted)",
                      }}
                    >
                      Max Width
                    </label>
                    <input
                      type="number"
                      className="form-input"
                      style={{ padding: "6px 10px", fontSize: "13px" }}
                      value={selectedItem.maxWidth || 0}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          maxWidth: parseInt(e.target.value) || 0,
                        })
                      }
                    />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <label
                      style={{
                        fontSize: "11px",
                        fontWeight: "bold",
                        color: "var(--text-muted)",
                      }}
                    >
                      Max Height
                    </label>
                    <input
                      type="number"
                      className="form-input"
                      style={{ padding: "6px 10px", fontSize: "13px" }}
                      value={selectedItem.maxHeight || 0}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          maxHeight: parseInt(e.target.value) || 0,
                        })
                      }
                    />
                  </div>
                </div>

                {/* Drag & Reshape Mode Buttons — contextually swap to Undo during active modes */}
                <div style={{ margin: "4px 0", display: "flex", gap: "6px" }}>
                  {/* LEFT BUTTON: Drag (idle) or Undo (while reshaping) */}
                  {interactionMode === "reshape" ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "5px",
                        fontSize: "12px",
                        padding: "9px 6px",
                      }}
                      onClick={handleUndo}
                      disabled={undoStack.length === 0}
                      title={`Undo last action${undoStack.length > 0 ? ` (${undoStack.length} available)` : " — nothing to undo"}`}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <polyline points="1 4 1 10 7 10" />
                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                      </svg>
                      Undo
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={`btn ${interactionMode === "drag" ? "btn-primary" : "btn-secondary"}`}
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "5px",
                        fontSize: "12px",
                        padding: "9px 6px",
                      }}
                      onClick={() =>
                        setInteractionMode((prev) =>
                          prev === "drag" ? "none" : "drag",
                        )
                      }
                      title="Drag the element to a new position on the image"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <polyline points="5 9 2 12 5 15" />
                        <polyline points="9 5 12 2 15 5" />
                        <polyline points="15 19 12 22 9 19" />
                        <polyline points="19 9 22 12 19 15" />
                        <line
                          x1="2"
                          y1="12"
                          x2="22"
                          y2="12"
                        />
                        <line
                          x1="12"
                          y1="2"
                          x2="12"
                          y2="22"
                        />
                      </svg>
                      {interactionMode === "drag" ? "Dragging…" : "Drag"}
                    </button>
                  )}

                  {/* RIGHT BUTTON: Reshape (idle) or Undo (while dragging) */}
                  {interactionMode === "drag" ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "5px",
                        fontSize: "12px",
                        padding: "9px 6px",
                      }}
                      onClick={handleUndo}
                      disabled={undoStack.length === 0}
                      title={`Undo last action${undoStack.length > 0 ? ` (${undoStack.length} available)` : " — nothing to undo"}`}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <polyline points="1 4 1 10 7 10" />
                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                      </svg>
                      Undo
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={`btn ${interactionMode === "reshape" ? "btn-primary" : "btn-secondary"}`}
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "5px",
                        fontSize: "12px",
                        padding: "9px 6px",
                      }}
                      onClick={() => {
                        if (interactionMode === "reshape") {
                          setInteractionMode("none");
                        } else {
                          handleEnterReshapeMode(selectedItem as LayerElement);
                        }
                      }}
                      title="Drag individual vertices to reshape the bubble polygon. Auto-generates polygon for rect/ellipse shapes."
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <circle
                          cx="5"
                          cy="5"
                          r="2.5"
                        />
                        <circle
                          cx="19"
                          cy="5"
                          r="2.5"
                        />
                        <circle
                          cx="19"
                          cy="19"
                          r="2.5"
                        />
                        <circle
                          cx="5"
                          cy="19"
                          r="2.5"
                        />
                        <line
                          x1="7.5"
                          y1="5"
                          x2="16.5"
                          y2="5"
                        />
                        <line
                          x1="19"
                          y1="7.5"
                          x2="19"
                          y2="16.5"
                        />
                        <line
                          x1="16.5"
                          y1="19"
                          x2="7.5"
                          y2="19"
                        />
                        <line
                          x1="5"
                          y1="16.5"
                          x2="5"
                          y2="7.5"
                        />
                      </svg>
                      {interactionMode === "reshape" ? "Reshaping…" : "Reshape"}
                    </button>
                  )}
                </div>

                {/* Font & Style settings */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "8px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <label
                      style={{
                        fontSize: "11px",
                        fontWeight: "bold",
                        color: "var(--text-muted)",
                      }}
                    >
                      Font Family
                    </label>
                    <select
                      className="form-input"
                      style={{
                        padding: "4px 8px",
                        fontSize: "13px",
                        height: "38px",
                        backgroundColor: "var(--bg-surface)",
                      }}
                      value={selectedItem.font || "Comic Neue"}
                      onChange={(e) =>
                        handleUpdateSelectedElement({ font: e.target.value })
                      }
                    >
                      <option value="Comic Neue">Comic Neue</option>
                      <option value="Bangers">Bangers</option>
                      <option value="Luckiest Guy">Luckiest Guy</option>
                      <option value="Arial">Arial</option>
                      <option value="Courier New">Courier New</option>
                    </select>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <label
                      style={{
                        fontSize: "11px",
                        fontWeight: "bold",
                        color: "var(--text-muted)",
                      }}
                    >
                      Font Size (pt)
                    </label>
                    <input
                      type="number"
                      className="form-input"
                      style={{ padding: "6px 10px", fontSize: "13px" }}
                      value={selectedItem.size || 16}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          size: parseFloat(e.target.value) || 12,
                          autoSize: false,
                        })
                      }
                    />
                  </div>
                </div>

                {/* Font Weight & Style Row */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "8px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <label
                      style={{
                        fontSize: "11px",
                        fontWeight: "bold",
                        color: "var(--text-muted)",
                      }}
                    >
                      Font Weight
                    </label>
                    <select
                      className="form-input"
                      style={{
                        padding: "4px 8px",
                        fontSize: "13px",
                        height: "38px",
                        backgroundColor: "var(--bg-surface)",
                      }}
                      value={selectedItem.fontWeight || "normal"}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          fontWeight: e.target.value,
                        })
                      }
                    >
                      <option value="normal">Normal</option>
                      <option value="bold">Bold</option>
                    </select>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <label
                      style={{
                        fontSize: "11px",
                        fontWeight: "bold",
                        color: "var(--text-muted)",
                      }}
                    >
                      Font Style
                    </label>
                    <select
                      className="form-input"
                      style={{
                        padding: "4px 8px",
                        fontSize: "13px",
                        height: "38px",
                        backgroundColor: "var(--bg-surface)",
                      }}
                      value={selectedItem.fontStyle || "normal"}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          fontStyle: e.target.value,
                        })
                      }
                    >
                      <option value="normal">Normal</option>
                      <option value="italic">Italic</option>
                    </select>
                  </div>
                </div>

                {/* Box Shape selection */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <label
                    style={{
                      fontSize: "11px",
                      fontWeight: "bold",
                      color: "var(--text-muted)",
                    }}
                  >
                    Box Shape
                  </label>
                  <select
                    className="form-input"
                    style={{
                      padding: "4px 8px",
                      fontSize: "13px",
                      height: "38px",
                      backgroundColor: "var(--bg-surface)",
                    }}
                    value={selectedItem.boxShape || "rectangular"}
                    onChange={(e) =>
                      handleUpdateSelectedElement({ boxShape: e.target.value })
                    }
                  >
                    <option value="rectangular">Rectangular</option>
                    <option value="elliptical">
                      Elliptical (Contour-Based)
                    </option>
                  </select>
                </div>

                {/* Mask Background Color (only relevant if clean background mask is enabled) */}
                {selectedItem.wordWrap && (
                  <ColorPicker
                    label="Mask Background Color"
                    value={
                      selectedItem.backgroundColor !== undefined &&
                      selectedItem.backgroundColor !== null
                        ? selectedItem.backgroundColor
                        : "#ffffff"
                    }
                    onChange={(val) =>
                      handleUpdateSelectedElement({ backgroundColor: val })
                    }
                    onLaunchEyeDropper={() =>
                      handleLaunchEyeDropper("backgroundColor")
                    }
                    allowTransparent={true}
                  />
                )}

                {/* Text Color (only relevant if it is a text-bearing element) */}
                {selectedItem.text !== undefined &&
                  selectedItem.text !== null && (
                    <ColorPicker
                      label="Text Color"
                      value={
                        selectedItem.textColor !== undefined &&
                        selectedItem.textColor !== null
                          ? selectedItem.textColor
                          : "#000000"
                      }
                      onChange={(val) =>
                        handleUpdateSelectedElement({ textColor: val })
                      }
                      onLaunchEyeDropper={() =>
                        handleLaunchEyeDropper("textColor")
                      }
                      allowTransparent={false}
                    />
                  )}

                {/* Rotation Slider */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <label
                    style={{
                      fontSize: "11px",
                      fontWeight: "bold",
                      color: "var(--text-muted)",
                    }}
                  >
                    Rotation ({selectedItem.rotation || 0}°)
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="360"
                    value={selectedItem.rotation || 0}
                    onChange={(e) =>
                      handleUpdateSelectedElement({
                        rotation: parseFloat(e.target.value) || 0,
                      })
                    }
                    style={{ width: "100%" }}
                  />
                </div>

                {/* Checkboxes Row */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                    borderTop: "1px solid var(--border-color)",
                    paddingTop: "10px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <input
                      type="checkbox"
                      id="autoSizeCheck"
                      checked={selectedItem.autoSize}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          autoSize: e.target.checked,
                        })
                      }
                    />
                    <label
                      htmlFor="autoSizeCheck"
                      style={{ fontSize: "12px", cursor: "pointer" }}
                    >
                      Auto-size text to fit bubble
                    </label>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <input
                      type="checkbox"
                      id="visibleCheck"
                      checked={selectedItem.visible}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          visible: e.target.checked,
                        })
                      }
                    />
                    <label
                      htmlFor="visibleCheck"
                      style={{ fontSize: "12px", cursor: "pointer" }}
                    >
                      Visible
                    </label>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <input
                      type="checkbox"
                      id="maskCheck"
                      checked={selectedItem.wordWrap}
                      onChange={(e) =>
                        handleUpdateSelectedElement({
                          wordWrap: e.target.checked,
                        })
                      }
                    />
                    <label
                      htmlFor="maskCheck"
                      style={{ fontSize: "12px", cursor: "pointer" }}
                    >
                      Clean background mask
                    </label>
                  </div>
                </div>

                {/* Action Buttons */}
                <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                  <button
                    className="btn btn-primary"
                    style={{
                      flex: 1,
                      padding: "8px",
                      position: "relative",
                      border: dirtyElements.has(selectedItem.id)
                        ? "1px solid var(--warning, #eab308)"
                        : undefined,
                    }}
                    onClick={() => handleSaveElementChanges(selectedItem)}
                  >
                    Save
                    {dirtyElements.has(selectedItem.id) && (
                      <span
                        style={{
                          position: "absolute",
                          top: "6px",
                          right: "6px",
                          width: "6px",
                          height: "6px",
                          borderRadius: "50%",
                          background: "var(--error, #ef4444)",
                        }}
                      />
                    )}
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{
                      flex: 1,
                      padding: "8px",
                      borderColor: "var(--error, #ef4444)",
                      color: "var(--error, #ef4444)",
                    }}
                    onClick={() => handleDeleteElement(selectedItem.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}

            {selectedItem && !selectedItem.isLayerElement && (
              <div
                className="ocr-detail-card"
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                <div
                  className="panel-section-title"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    margin: 0,
                  }}
                >
                  <span>
                    {selectedItem.isConversation
                      ? "Conversation Inspector"
                      : "Region Inspector"}
                  </span>
                  <button
                    onClick={() => setSelectedItem(null)}
                    style={{
                      background: "transparent",
                      border: "1px solid var(--border-color)",
                      color: "var(--text-main)",
                      borderRadius: "6px",
                      padding: "4px 8px",
                      cursor: "pointer",
                      fontSize: "11px",
                      fontWeight: 600,
                    }}
                  >
                    Deselect
                  </button>
                </div>

                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "6px",
                    margin: "4px 0 8px",
                  }}
                >
                  <span
                    className="meta-badge"
                    style={{
                      backgroundColor: "var(--primary-glow)",
                      color: "var(--primary-hover)",
                      borderColor: "var(--primary)",
                    }}
                  >
                    {selectedItem.isConversation
                      ? `Conv #${selectedItem.regions[0]?.bubbleReadingOrder}`
                      : `Bubble #${selectedItem.regions[0]?.bubbleReadingOrder}`}
                  </span>
                  <span
                    className="meta-badge"
                    style={{
                      backgroundColor: "var(--success-glow)",
                      color: "var(--success)",
                    }}
                  >
                    {selectedItem.regions[0]?.detectedLanguage || "unknown"}
                  </span>
                  {selectedItem.isConversation && (
                    <span
                      className="meta-badge"
                      style={{ textTransform: "capitalize" }}
                    >
                      {selectedItem.sceneType}
                    </span>
                  )}
                  {selectedItem.approved && (
                    <span
                      className="meta-badge"
                      style={{
                        backgroundColor: "rgba(16, 185, 129, 0.15)",
                        color: "var(--success)",
                        borderColor: "var(--success)",
                      }}
                    >
                      Approved
                    </span>
                  )}
                </div>

                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--text-muted)",
                    marginBottom: "8px",
                  }}
                >
                  Position: x={selectedItem.bboxX}, y={selectedItem.bboxY} (
                  {selectedItem.bboxW}x{selectedItem.bboxH})
                </div>

                <div
                  style={{
                    overflowY: "auto",
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                  }}
                >
                  {selectedItem.regions.map((reg: OcrRegion, idx: number) => (
                    <div
                      key={reg.id}
                      style={{
                        borderBottom:
                          idx < selectedItem.regions.length - 1
                            ? "1px dashed var(--border-color)"
                            : "none",
                        paddingBottom: "12px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "10px",
                          fontWeight: 700,
                          color: "var(--text-muted)",
                          marginBottom: "4px",
                          textTransform: "uppercase",
                        }}
                      >
                        Region #{idx + 1} Original
                      </div>
                      <div
                        className="ocr-text-preview"
                        style={{ marginBottom: "8px" }}
                      >
                        {reg.text}
                      </div>

                      {reg.translatedText && (
                        <>
                          <div
                            style={{
                              fontSize: "10px",
                              fontWeight: 700,
                              color: "var(--text-muted)",
                              marginBottom: "4px",
                              textTransform: "uppercase",
                            }}
                          >
                            Region #{idx + 1} Translation
                          </div>
                          <div
                            className="ocr-text-preview"
                            style={{
                              color: "var(--primary-hover)",
                              borderColor: "var(--primary)",
                            }}
                          >
                            {reg.translatedText}
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText={confirmModal.confirmText}
        isDangerous={confirmModal.isDangerous}
        onConfirm={confirmModal.onConfirm}
        onCancel={closeConfirm}
      />
      <InfoModal
        isOpen={infoModal.isOpen}
        title={infoModal.title}
        message={infoModal.message}
        type={infoModal.type}
        onClose={closeInfo}
      />
    </div>
  );
};

export default Reader;
