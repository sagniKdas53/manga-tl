import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { User, Chapter, Page, Panel, OcrRegion, Conversation, Layer, LayerElement, Series } from '../types';
import { safeFetch, toSlug } from '../utils';
import { fitTextInBox } from '../utils/fitText';
import ConfirmModal from './ConfirmModal';
import JSZip from 'jszip';

const normalizeHexColor = (val: string | null | undefined): string => {
  if (!val) return '#ffffff';
  let clean = val.trim();
  if (clean === 'transparent') return '#ffffff';
  if (!clean.startsWith('#')) {
    if (/^[0-9a-fA-F]{3}$/.test(clean) || /^[0-9a-fA-F]{6}$/.test(clean)) {
      clean = '#' + clean;
    } else {
      return '#ffffff';
    }
  }
  if (/^#[0-9a-fA-F]{3}$/.test(clean)) {
    const r = clean[1];
    const g = clean[2];
    const b = clean[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(clean)) {
    return clean;
  }
  return '#ffffff';
};

const normalizeHexTextColor = (val: string | null | undefined): string => {
  if (!val) return '#000000';
  let clean = val.trim();
  if (clean === 'transparent') return '#000000';
  if (!clean.startsWith('#')) {
    if (/^[0-9a-fA-F]{3}$/.test(clean) || /^[0-9a-fA-F]{6}$/.test(clean)) {
      clean = '#' + clean;
    } else {
      return '#000000';
    }
  }
  if (/^#[0-9a-fA-F]{3}$/.test(clean)) {
    const r = clean[1];
    const g = clean[2];
    const b = clean[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(clean)) {
    return clean;
  }
  return '#000000';
};

interface ReaderProps {
  user: User;
  selectedSeries: Series | null;
  selectedChapter: Chapter | null;
  chapters: Chapter[];
  pages: Page[];
  theme: 'light' | 'dark';
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

type SelectedItemType = (RenderItem & LayerElement) | RenderItem | LayerElement | null;

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
  const curPageNum = parseInt(pageNumber || '1');
  const totalPages = pages.length;
  const selectedPage = pages.find(p => p.pageNumber === curPageNum);

  // Reader States
  const [panels, setPanels] = useState<Panel[]>([]);
  const [ocrRegions, setOcrRegions] = useState<OcrRegion[]>([]);
  const [imageDims, setImageDims] = useState({ w: 800, h: 1200 });
  const [showPanels, setShowPanels] = useState(() => {
    const saved = localStorage.getItem('manga_show_panels');
    return saved === null ? true : saved === 'true';
  });
  const [showOcr, setShowOcr] = useState(() => {
    const saved = localStorage.getItem('manga_show_ocr');
    return saved === null ? true : saved === 'true';
  });
  const [showTranslations] = useState(false);
  const [showLeftSidebar, setShowLeftSidebar] = useState(() => {
    const saved = localStorage.getItem('manga_show_left_sidebar');
    return saved === null ? true : saved === 'true';
  });
  const [showRightSidebar, setShowRightSidebar] = useState(() => {
    const saved = localStorage.getItem('manga_show_right_sidebar');
    return saved === null ? true : saved === 'true';
  });
  const [isLoadingPageDetails, setIsLoadingPageDetails] = useState(false);
  const [loadedImageId, setLoadedImageId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(() => {
    const saved = localStorage.getItem('manga_zoom');
    const parsed = parseFloat(saved || '1.0');
    return isNaN(parsed) ? 1.0 : parsed;
  });

  // Phase 4 Layer System states
  const [layers, setLayers] = useState<{ layer: Layer; elements: LayerElement[] }[]>([]);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [cleanScanlationView, setCleanScanlationView] = useState(() => {
    const saved = localStorage.getItem('manga_clean_view');
    return saved === null ? false : saved === 'true';
  });
  const [undoStack, setUndoStack] = useState<LayerElement[]>([]);
  const [redoStack, setRedoStack] = useState<LayerElement[]>([]);

  // Conversation and Layout enhancements
  const [groupByConversation, setGroupByConversation] = useState(() => {
    const saved = localStorage.getItem('manga_group_by_conversation');
    return saved === null ? true : saved === 'true';
  });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedItem, setSelectedItem] = useState<SelectedItemType>(null);
  const [activeItem, setActiveItem] = useState<RenderItem | null>(null);
  const [fitMode, setFitMode] = useState<'page' | 'width' | 'height'>(() => {
    const saved = localStorage.getItem('manga_fit_mode');
    return (saved === 'page' || saved === 'width' || saved === 'height') ? saved : 'page';
  });
  const [isRedoingPageOcr, setIsRedoingPageOcr] = useState(false);
  const [isRedoingPageTranslation, setIsRedoingPageTranslation] = useState(false);

  // Pan & Drag States
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDraggingCanvas, setIsDraggingCanvas] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const [draggedElement, setDraggedElement] = useState<{
    id: string;
    type: 'move' | 'resize-br' | 'resize-tr' | 'resize-bl' | 'resize-tl';
    startX: number;
    startY: number;
    startElX: number;
    startElY: number;
    startElW: number;
    startElH: number;
  } | null>(null);

  // Touch & Zoom enhancements
  // Detected once at component initialization — never changes after mount
  const isTouchScreen = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const [showZoomBar, setShowZoomBar] = useState(() => {
    const saved = localStorage.getItem('manga_show_zoom_bar');
    return saved === 'false' ? false : true;
  });
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });

  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const touchStartDist = useRef<number | null>(null);
  const touchStartZoom = useRef<number>(1.0);
  const initialTouchPos = useRef({ x: 0, y: 0 });
  const hasMoved = useRef(false);

  // Persistence effects
  useEffect(() => {
    localStorage.setItem('manga_show_zoom_bar', showZoomBar.toString());
  }, [showZoomBar]);

  useEffect(() => {
    localStorage.setItem('manga_show_panels', showPanels.toString());
  }, [showPanels]);

  useEffect(() => {
    localStorage.setItem('manga_show_ocr', showOcr.toString());
  }, [showOcr]);

  useEffect(() => {
    localStorage.setItem('manga_show_left_sidebar', showLeftSidebar.toString());
  }, [showLeftSidebar]);

  useEffect(() => {
    localStorage.setItem('manga_show_right_sidebar', showRightSidebar.toString());
  }, [showRightSidebar]);

  useEffect(() => {
    localStorage.setItem('manga_clean_view', cleanScanlationView.toString());
  }, [cleanScanlationView]);

  useEffect(() => {
    localStorage.setItem('manga_group_by_conversation', groupByConversation.toString());
  }, [groupByConversation]);

  useEffect(() => {
    localStorage.setItem('manga_fit_mode', fitMode);
  }, [fitMode]);

  useEffect(() => {
    localStorage.setItem('manga_zoom', zoom.toString());
  }, [zoom]);

  // Window title synchronization
  useEffect(() => {
    if (selectedChapter) {
      const seriesTitle = selectedSeries ? selectedSeries.title : 'Series';
      const chapterNum = selectedChapter.chapterNumber;
      const pageNum = curPageNum;
      document.title = `[TLHub] ${seriesTitle} - Ch. ${chapterNum} Page ${pageNum}`;
    } else {
      document.title = 'TLHub - Manga Translation Platform';
    }
    return () => {
      document.title = 'TLHub';
    };
  }, [selectedSeries, selectedChapter, curPageNum]);

  // Chapter navigation logic
  const sortedChapters = [...chapters].sort((a, b) => a.chapterNumber - b.chapterNumber);
  const currentChapterIdx = sortedChapters.findIndex(c => c.id === selectedChapter?.id);
  const prevChapter = currentChapterIdx > 0 ? sortedChapters[currentChapterIdx - 1] : null;
  const nextChapter = currentChapterIdx !== -1 && currentChapterIdx < sortedChapters.length - 1 ? sortedChapters[currentChapterIdx + 1] : null;

  const navigateToChapter = (chapter: Chapter) => {
    const slugPart = chapter.title ? `${toSlug(chapter.title)}/` : `chapter-${chapter.chapterNumber}/`;
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
          height: entry.contentRect.height
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
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const closeConfirm = () => setConfirmModal(prev => ({ ...prev, isOpen: false }));

  // Image ref for export
  const imgRef = useRef<HTMLImageElement>(null);

  // Popover States
  const [activeRegion, setActiveRegion] = useState<OcrRegion | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [isEditingRegion, setIsEditingRegion] = useState(false);
  const [editText, setEditText] = useState('');
  const [isRedoing, setIsRedoing] = useState(false);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Helper to get combined text (original or translated) for a grouped item
  const getCombinedText = useCallback((item: RenderItem, showTrans: boolean) => {
    if (!item || !item.regions) return '';
    return item.regions
      .map((r: OcrRegion) => showTrans ? (r.translatedText || '') : r.text)
      .join('\n');
  }, []);

  // Compute union bounding box for conversations
  const conversationsWithRegions = React.useMemo(() => {
    if (!groupByConversation || conversations.length === 0) {
      return [];
    }

    return conversations.map(conv => {
      const regionsInConv = conv.regions
        .map(cr => ocrRegions.find(r => r.id === cr.regionId))
        .filter((r): r is OcrRegion => !!r);
      
      let bboxX = 0, bboxY = 0, bboxW = 0, bboxH = 0;
      if (regionsInConv.length > 0) {
        const minX = Math.min(...regionsInConv.map(r => r.bboxX));
        const minY = Math.min(...regionsInConv.map(r => r.bboxY));
        const maxX = Math.max(...regionsInConv.map(r => r.bboxX + r.bboxW));
        const maxY = Math.max(...regionsInConv.map(r => r.bboxY + r.bboxH));
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
        approved: regionsInConv.length > 0 && regionsInConv.every(r => r.approved),
      };
    }).filter(c => c.regions.length > 0);
  }, [conversations, ocrRegions, groupByConversation]);

  // Unified list of renderable items (conversations or standalone regions)
  const renderItems = React.useMemo(() => {
    if (!groupByConversation || conversations.length === 0) {
      return ocrRegions.map(r => ({
        id: `region-${r.id}`,
        isConversation: false,
        regions: [r],
        bboxX: r.bboxX,
        bboxY: r.bboxY,
        bboxW: r.bboxW,
        bboxH: r.bboxH,
        approved: r.approved === true,
        sceneType: 'speech',
        originalRegion: r
      }));
    }

    const groupedRegionIds = new Set(conversations.flatMap(c => c.regions.map(r => r.regionId)));

    const convItems = conversationsWithRegions.map(conv => ({
      id: `conv-${conv.id}`,
      isConversation: true,
      regions: conv.regions,
      bboxX: conv.bboxX,
      bboxY: conv.bboxY,
      bboxW: conv.bboxW,
      bboxH: conv.bboxH,
      approved: conv.approved,
      sceneType: conv.sceneType,
      conversationData: conv
    }));

    const ungroupedItems = ocrRegions
      .filter(r => !groupedRegionIds.has(r.id))
      .map(r => ({
        id: `region-${r.id}`,
        isConversation: false,
        regions: [r],
        bboxX: r.bboxX,
        bboxY: r.bboxY,
        bboxW: r.bboxW,
        bboxH: r.bboxH,
        approved: r.approved === true,
        sceneType: 'speech',
        originalRegion: r
      }));

    return [...convItems, ...ungroupedItems];
  }, [groupByConversation, ocrRegions, conversations, conversationsWithRegions]);

  // Dynamic calculation of the absolute zoom percentage
  const displayedZoom = React.useMemo(() => {
    if (imageDims.w <= 0 || imageDims.h <= 0) return 100;
    const aspectRatio = imageDims.w / imageDims.h;
    const vh = window.innerHeight;
    const containerWidth = Math.max(100, containerSize.width - 48); // 24px padding on each side
    const refWidth = Math.min(containerWidth, vh * 0.8 * aspectRatio);
    
    let targetWidth = refWidth;
    if (fitMode === 'page') {
      targetWidth = refWidth * zoom;
    } else if (fitMode === 'width') {
      targetWidth = containerWidth * zoom;
    } else if (fitMode === 'height') {
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
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(res => {
        if (!res.ok) throw new Error('Image details fetch failed');
        return res.json();
      })
      .then(data => {
        setPanels(data.panels || []);
        setOcrRegions(data.ocrRegions || []);
        setConversations(data.conversations || []);
        setSelectedItem(null);
        setLoadedImageId(selectedPage.imageId);
        setIsLoadingPageDetails(false);
      })
      .catch(err => {
        console.error('Error loading page details:', err);
        setIsLoadingPageDetails(false);
      });

      // Fetch layers
      safeFetch(`/api/images/${selectedPage.imageId}/layers`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(res => {
        if (!res.ok) throw new Error('Layers fetch failed');
        return res.json();
      })
      .then(layersData => {
        const data = layersData || [];
        setLayers(data);
        if (data.length > 0) {
          setActiveLayerId(data[0].layer.id);
        } else {
          setActiveLayerId(null);
        }
      })
      .catch(err => {
        console.error('Error loading layers:', err);
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
    });
  }, [pageNumber]);

  // History Undo/Redo operations
  const pushToHistoryStack = useCallback((prevState: LayerElement) => {
    setUndoStack(prev => [...prev.slice(-49), { ...prevState }]);
    setRedoStack([]);
  }, []);

  // Declared before handleUndo/handleRedo so the callbacks can reference it
  const handleSaveElementChanges = useCallback(async (element: LayerElement, showAlert: boolean = true) => {
    try {
      const res = await safeFetch(`/api/layer-elements/${element.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}`
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
          fontWeight: element.fontWeight || 'normal',
          fontStyle: element.fontStyle || 'normal'
        })
      });

      if (!res.ok) {
        throw new Error('Failed to update element on server');
      }

      if (showAlert) {
        alert('Element updated successfully!');
      }
    } catch (err) {
      console.error(err);
      alert('Error updating element on server.');
    }
  }, [user.token]);

  const handleUndo = useCallback(async () => {
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack(prev => prev.slice(0, -1));

    if (selectedItem && selectedItem.isLayerElement) {
      const currentElement = { ...selectedItem };
      setRedoStack(prev => [...prev, currentElement as LayerElement]);

      setSelectedItem(previous as SelectedItemType);
      setLayers(prevLayers => prevLayers.map(l => {
        if (l.layer.id === previous.layerId) {
          return {
            ...l,
            elements: l.elements.map(el => el.id === previous.id ? previous : el)
          };
        }
        return l;
      }));

      await handleSaveElementChanges(previous, false);
    }
  }, [undoStack, selectedItem, handleSaveElementChanges]);

  const handleRedo = useCallback(async () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack(prev => prev.slice(0, -1));

    if (selectedItem && selectedItem.isLayerElement) {
      const currentElement = { ...selectedItem };
      setUndoStack(prev => [...prev, currentElement as LayerElement]);

      setSelectedItem(next as SelectedItemType);
      setLayers(prevLayers => prevLayers.map(l => {
        if (l.layer.id === next.layerId) {
          return {
            ...l,
            elements: l.elements.map(el => el.id === next.id ? next : el)
          };
        }
        return l;
      }));

      await handleSaveElementChanges(next, false);
    }
  }, [redoStack, selectedItem, handleSaveElementChanges]);

  // Key Down Listener for undo/redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' || 
        target.tagName === 'TEXTAREA' || 
        target.isContentEditable
      ) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo]);

  const handleUpdateSelectedElement = (updates: Partial<LayerElement>) => {
    setSelectedItem((prev: SelectedItemType) => {
      if (!prev) return null;
      
      // Push previous state to undo stack
      pushToHistoryStack(prev as LayerElement);

      const updated = { ...prev, ...updates };

      setLayers(prevLayers => prevLayers.map(l => {
        if (l.layer.id === (updated as LayerElement).layerId) {
          return {
            ...l,
            elements: l.elements.map(el => el.id === (updated as LayerElement).id ? (updated as LayerElement) : el)
          };
        }
        return l;
      }));

      return updated as SelectedItemType;
    });
  };

  const handleElementDragStart = (
    e: React.MouseEvent,
    element: LayerElement,
    type: 'move' | 'resize-br' | 'resize-tr' | 'resize-bl' | 'resize-tl'
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const svg = e.currentTarget.closest('svg');
    if (!svg) return;
    const point = svg.createSVGPoint();
    point.x = e.clientX;
    point.y = e.clientY;
    const svgPoint = point.matrixTransform(svg.getScreenCTM()!.inverse());
    
    setDraggedElement({
      id: element.id,
      type,
      startX: svgPoint.x,
      startY: svgPoint.y,
      startElX: element.x,
      startElY: element.y,
      startElW: element.maxWidth || 100,
      startElH: element.maxHeight || 100,
    });
  };

  useEffect(() => {
    if (!draggedElement) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      const svg = document.querySelector('.svg-overlay') as SVGSVGElement | null;
      if (!svg) return;

      const point = svg.createSVGPoint();
      point.x = e.clientX;
      point.y = e.clientY;
      const svgPoint = point.matrixTransform(svg.getScreenCTM()!.inverse());

      const dx = svgPoint.x - draggedElement.startX;
      const dy = svgPoint.y - draggedElement.startY;

      let newX = draggedElement.startElX;
      let newY = draggedElement.startElY;
      let newW = draggedElement.startElW;
      let newH = draggedElement.startElH;

      if (draggedElement.type === 'move') {
        newX = Math.round(draggedElement.startElX + dx);
        newY = Math.round(draggedElement.startElY + dy);
      } else if (draggedElement.type === 'resize-br') {
        newW = Math.max(10, Math.round(draggedElement.startElW + dx));
        newH = Math.max(10, Math.round(draggedElement.startElH + dy));
      } else if (draggedElement.type === 'resize-tr') {
        newW = Math.max(10, Math.round(draggedElement.startElW + dx));
        const possibleH = Math.round(draggedElement.startElH - dy);
        if (possibleH > 10) {
          newH = possibleH;
          newY = Math.round(draggedElement.startElY + dy);
        }
      } else if (draggedElement.type === 'resize-bl') {
        const possibleW = Math.round(draggedElement.startElW - dx);
        if (possibleW > 10) {
          newW = possibleW;
          newX = Math.round(draggedElement.startElX + dx);
        }
        newH = Math.max(10, Math.round(draggedElement.startElH + dy));
      } else if (draggedElement.type === 'resize-tl') {
        const possibleW = Math.round(draggedElement.startElW - dx);
        const possibleH = Math.round(draggedElement.startElH - dy);
        if (possibleW > 10) {
          newW = possibleW;
          newX = Math.round(draggedElement.startElX + dx);
        }
        if (possibleH > 10) {
          newH = possibleH;
          newY = Math.round(draggedElement.startElY + dy);
        }
      }

      setSelectedItem(prev => {
        if (prev && 'id' in prev && prev.id === draggedElement.id) {
          return {
            ...prev,
            x: newX,
            y: newY,
            maxWidth: newW,
            maxHeight: newH
          };
        }
        return prev;
      });

      setLayers(prevLayers => prevLayers.map(l => {
        const hasElement = l.elements.some(el => el.id === draggedElement.id);
        if (hasElement) {
          return {
            ...l,
            elements: l.elements.map(el => el.id === draggedElement.id ? {
              ...el,
              x: newX,
              y: newY,
              maxWidth: newW,
              maxHeight: newH
            } : el)
          };
        }
        return l;
      }));
    };

    const handleWindowMouseUp = async () => {
      if (!draggedElement) return;

      let updatedElement: LayerElement | undefined;
      setLayers(prevLayers => {
        for (const layer of prevLayers) {
          const found = layer.elements.find(el => el.id === draggedElement.id);
          if (found) {
            updatedElement = found;
            break;
          }
        }
        return prevLayers;
      });

      if (updatedElement) {
        const originalElement: LayerElement = {
          ...(updatedElement as LayerElement),
          x: draggedElement.startElX,
          y: draggedElement.startElY,
          maxWidth: draggedElement.startElW,
          maxHeight: draggedElement.startElH
        };
        pushToHistoryStack(originalElement);
        await handleSaveElementChanges(updatedElement, false);
      }

      setDraggedElement(null);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [draggedElement, layers, selectedItem, pushToHistoryStack, handleSaveElementChanges]);

  const handleCreateLayer = async (type: 'translation' | 'sfx') => {
    if (!selectedPage) return;
    let targetLanguage: string | null = null;
    if (type === 'translation') {
      targetLanguage = prompt('Enter target language code (e.g. en, es, fr):', 'en');
      if (!targetLanguage) return;
    }

    try {
      const res = await safeFetch(`/api/images/${selectedPage.imageId}/layers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}`
        },
        body: JSON.stringify({
          type,
          targetLanguage: targetLanguage ? targetLanguage.toLowerCase() : null,
          visible: true,
          zOrder: layers.length
        })
      });

      if (!res.ok) throw new Error('Failed to create layer');
      
      const newLayer = await res.json();
      setLayers(prev => [...prev, { layer: newLayer, elements: [] }]);
      setActiveLayerId(newLayer.id);
    } catch (err) {
      console.error(err);
      alert('Error creating layer.');
    }
  };

  const handleCreateTranslationLayer = () => handleCreateLayer('translation');
  const handleCreateSfxLayer = () => handleCreateLayer('sfx');

  const handleAddNewElement = async (type: 'text' | 'mask') => {
    if (!activeLayerId) {
      alert('Please select or create an active layer first.');
      return;
    }

    try {
      const res = await safeFetch(`/api/layers/${activeLayerId}/elements`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}`
        },
        body: JSON.stringify({
          text: type === 'text' ? 'New Text' : '',
          font: 'Comic Neue',
          size: 16.0,
          autoSize: false,
          maxWidth: type === 'text' ? 150 : 100,
          maxHeight: type === 'text' ? 80 : 100,
          wordWrap: type === 'mask',
          rotation: 0.0,
          x: 100.0,
          y: 100.0,
          visible: true,
          backgroundColor: type === 'mask' ? '#ffffff' : null,
          textColor: type === 'text' ? '#000000' : null,
          fontWeight: 'normal',
          fontStyle: 'normal'
        })
      });

      if (!res.ok) throw new Error('Failed to create layer element');

      const newElement = await res.json();
      const elementWithFlag = { ...newElement, isLayerElement: true };

      setLayers(prevLayers => prevLayers.map(l => {
        if (l.layer.id === activeLayerId) {
          return {
            ...l,
            elements: [...l.elements, elementWithFlag]
          };
        }
        return l;
      }));

      setSelectedItem(elementWithFlag);
    } catch (err) {
      console.error(err);
      alert('Error creating layer element.');
    }
  };

  const handleDeleteElement = async (elementId: string) => {
    setConfirmModal({
      isOpen: true,
      title: 'Delete Element',
      message: 'Are you sure you want to delete this element?',
      confirmText: 'Delete',
      isDangerous: true,
      onConfirm: async () => {
        closeConfirm();
        try {
          const res = await safeFetch(`/api/layer-elements/${elementId}`, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${user.token}`
            }
          });

          if (!res.ok) throw new Error('Failed to delete layer element');

          setLayers(prevLayers => prevLayers.map(l => ({
            ...l,
            elements: l.elements.filter(el => el.id !== elementId)
          })));

          setSelectedItem(null);
        } catch (err) {
          console.error(err);
          alert('Error deleting layer element.');
        }
      }
    });
  };

  const handleLaunchEyeDropper = async (targetField: 'backgroundColor' | 'textColor' = 'backgroundColor') => {
    if (!selectedItem || !selectedItem.isLayerElement) {
      alert('Please select a mask or text element first.');
      return;
    }

    if (typeof (window as any).EyeDropper === 'undefined') {
      alert('EyeDropper API is not supported in this browser. Please use the color input in the Element Inspector.');
      return;
    }

    const eyeDropper = new (window as any).EyeDropper();
    try {
      const result = await eyeDropper.open();
      const color = result.sRGBHex;
      handleUpdateSelectedElement({ [targetField]: color });
    } catch (err) {
      console.error('EyeDropper failed or cancelled:', err);
    }
  };

  const handleToggleLayerVisibility = (layerId: string) => {
    setLayers(prev => prev.map(l => {
      if (l.layer.id === layerId) {
        return {
          ...l,
          layer: {
            ...l.layer,
            visible: !l.layer.visible
          }
        };
      }
      return l;
    }));
  };

  const handleDeleteLayer = (layerId: string) => {
    setConfirmModal({
      isOpen: true,
      title: 'Delete Layer',
      message: 'Are you sure you want to delete this layer? This action cannot be undone.',
      confirmText: 'Delete Layer',
      isDangerous: true,
      onConfirm: async () => {
        closeConfirm();
        try {
      const res = await safeFetch(`/api/layers/${layerId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${user.token}`
        }
      });

          if (!res.ok) throw new Error('Failed to delete layer');
          setLayers(prev => prev.filter(l => l.layer.id !== layerId));
        } catch (err) {
          console.error(err);
        }
      },
    });
  };

  // --- EXPORT HANDLERS ---
  const handleExportPng = useCallback(() => {
    if (!selectedPage || !imgRef.current) return;
    const img = imgRef.current;
    const W = imageDims.w;
    const H = imageDims.h;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Draw the base page image
    ctx.drawImage(img, 0, 0, W, H);

    // Draw visible layer elements
    layers.forEach(lData => {
      if (!lData.layer.visible) return;
      lData.elements.forEach(el => {
        if (!el.visible) return;
        const width = el.maxWidth || 100;
        const height = el.maxHeight || 100;

        ctx.save();
        // Apply rotation around element center
        const cx = el.x + width / 2;
        const cy = el.y + height / 2;
        ctx.translate(cx, cy);
        ctx.rotate(((el.rotation || 0) * Math.PI) / 180);
        ctx.translate(-cx, -cy);

        // White mask backdrop
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(el.x, el.y, width, height);

        // Draw text
        const fit = fitTextInBox(
          el.text || '',
          width - 8,
          height - 8,
          el.font || 'Comic Neue',
          el.size || 16
        );
        const fSize = fit.fontSize;
        ctx.font = `bold ${fSize}px "${el.font || 'Comic Neue'}", sans-serif`;
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const lineH = fSize * 1.2;
        const startY = el.y + height / 2 - ((fit.lines.length - 1) * lineH) / 2;
        fit.lines.forEach((line, i) => {
          ctx.fillText(line, el.x + width / 2, startY + i * lineH);
        });

        ctx.restore();
      });
    });

    // Trigger download
    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `page-${selectedPage.pageNumber}-export.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }, [selectedPage, imageDims, layers]);

  const handleExportZip = useCallback(async () => {
    if (!selectedPage || !imgRef.current) return;
    const img = imgRef.current;
    const W = imageDims.w;
    const H = imageDims.h;

    const zip = new JSZip();

    // 1. original.png
    const origCanvas = document.createElement('canvas');
    origCanvas.width = W;
    origCanvas.height = H;
    const origCtx = origCanvas.getContext('2d')!;
    origCtx.drawImage(img, 0, 0, W, H);
    const origBlob = await new Promise<Blob>(res => origCanvas.toBlob(b => res(b!), 'image/png'));
    zip.file('original.png', origBlob);

    // 2. mask.png  – white backdrop rects only, on transparent canvas
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = W;
    maskCanvas.height = H;
    const maskCtx = maskCanvas.getContext('2d')!;
    layers.forEach(lData => {
      if (!lData.layer.visible) return;
      lData.elements.forEach(el => {
        if (!el.visible) return;
        const width = el.maxWidth || 100;
        const height = el.maxHeight || 100;
        maskCtx.save();
        const cx = el.x + width / 2;
        const cy = el.y + height / 2;
        maskCtx.translate(cx, cy);
        maskCtx.rotate(((el.rotation || 0) * Math.PI) / 180);
        maskCtx.translate(-cx, -cy);
        maskCtx.fillStyle = '#ffffff';
        maskCtx.fillRect(el.x, el.y, width, height);
        maskCtx.restore();
      });
    });
    const maskBlob = await new Promise<Blob>(res => maskCanvas.toBlob(b => res(b!), 'image/png'));
    zip.file('mask.png', maskBlob);

    // 3. translation.png – text only, on transparent canvas
    const textCanvas = document.createElement('canvas');
    textCanvas.width = W;
    textCanvas.height = H;
    const textCtx = textCanvas.getContext('2d')!;
    layers.forEach(lData => {
      if (!lData.layer.visible || lData.layer.type !== 'translation') return;
      lData.elements.forEach(el => {
        if (!el.visible) return;
        const width = el.maxWidth || 100;
        const height = el.maxHeight || 100;
        const fit = fitTextInBox(
          el.text || '',
          width - 8,
          height - 8,
          el.font || 'Comic Neue',
          el.size || 16
        );
        const fSize = fit.fontSize;
        textCtx.save();
        const cx = el.x + width / 2;
        const cy = el.y + height / 2;
        textCtx.translate(cx, cy);
        textCtx.rotate(((el.rotation || 0) * Math.PI) / 180);
        textCtx.translate(-cx, -cy);
        textCtx.font = `bold ${fSize}px "${el.font || 'Comic Neue'}", sans-serif`;
        textCtx.fillStyle = '#000000';
        textCtx.textAlign = 'center';
        textCtx.textBaseline = 'middle';
        const lineH = fSize * 1.2;
        const startY = el.y + height / 2 - ((fit.lines.length - 1) * lineH) / 2;
        fit.lines.forEach((line, i) => {
          textCtx.fillText(line, el.x + width / 2, startY + i * lineH);
        });
        textCtx.restore();
      });
    });
    const textBlob = await new Promise<Blob>(res => textCanvas.toBlob(b => res(b!), 'image/png'));
    zip.file('translation.png', textBlob);

    // 4. project.json
    const projectData = {
      pageNumber: selectedPage.pageNumber,
      imageId: selectedPage.imageId,
      dimensions: { width: W, height: H },
      exportedAt: new Date().toISOString(),
      layers: layers.map(lData => ({
        id: lData.layer.id,
        type: lData.layer.type,
        targetLanguage: lData.layer.targetLanguage,
        visible: lData.layer.visible,
        zOrder: lData.layer.zOrder,
        elements: lData.elements.map(el => ({
          id: el.id,
          text: el.text,
          font: el.font || 'Comic Neue',
          size: el.size,
          autoSize: el.autoSize,
          x: el.x,
          y: el.y,
          maxWidth: el.maxWidth,
          maxHeight: el.maxHeight,
          rotation: el.rotation,
          visible: el.visible,
          wordWrap: el.wordWrap,
        })),
      })),
    };
    zip.file('project.json', JSON.stringify(projectData, null, 2));

    // Generate and download zip
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `page-${selectedPage.pageNumber}-layers.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }, [selectedPage, imageDims, layers]);

  // --- STABLE NAVIGATOR CALLBACK ---
  const navigateToPage = useCallback((num: number) => {
    if (num >= 1 && num <= pages.length && selectedChapter) {
      const slugPart = selectedChapter.title ? `${toSlug(selectedChapter.title)}/` : `chapter-${selectedChapter.chapterNumber}/`;
      navigate(`/chapters/${selectedChapter.id}/${slugPart}reader/${num}`);
    }
  }, [pages, selectedChapter, navigate]);

  // --- KEYBOARD WRITER EFFECT ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' || 
        target.tagName === 'TEXTAREA' || 
        target.isContentEditable
      ) {
        return;
      }
      
      if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') {
        navigateToPage(curPageNum + 1);
      } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a') {
        navigateToPage(curPageNum - 1);
      } else if (e.key === 'Escape') {
        setSelectedItem(null);
        setActiveRegion(null);
        setActiveItem(null);
        setPopoverOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [curPageNum, navigateToPage]);

  // --- PANNING / DRAGGING WORKSPACE ---
  const handleMouseDownCanvas = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left click
    if (
      (e.target as HTMLElement).closest('.svg-ocr-box') || 
      (e.target as HTMLElement).closest('.svg-conv-box') || 
      (e.target as HTMLElement).closest('.bubble-popover') ||
      (e.target as HTMLElement).closest('.floating-reader-toolbar') ||
      (e.target as HTMLElement).closest('.vertical-zoom-toolbar') ||
      (e.target as HTMLElement).closest('.delete-page-btn') ||
      (e.target as HTMLElement).closest('.reorder-controls')
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
      y: e.clientY - dragStart.current.y
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
      target.closest('.svg-ocr-box') || 
      target.closest('.svg-conv-box') || 
      target.closest('.bubble-popover') ||
      target.closest('.floating-reader-toolbar') ||
      target.closest('.vertical-zoom-toolbar') ||
      target.closest('.delete-page-btn') ||
      target.closest('.reorder-controls')
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
        y: e.touches[0].clientY - pan.y
      };
      initialTouchPos.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY
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
        y: e.touches[0].clientY - dragStart.current.y
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
      target.closest('.manga-canvas-wrapper') ||
      target.closest('.vertical-zoom-toolbar') ||
      target.closest('.reader-sidebar-nhentai') ||
      target.closest('.reader-navbar-nhentai') ||
      target.closest('.reader-footer-nhentai')
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
  const handleMouseEnterItem = useCallback((item: RenderItem) => {
    if (hideTimeout.current) clearTimeout(hideTimeout.current);
    setActiveItem(item);
    setActiveRegion(item.regions[0] || null);
    setPopoverOpen(true);
    setEditText(getCombinedText(item, showTranslations));
  }, [showTranslations, getCombinedText]);

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
    setOcrRegions(prev => prev.map(r => {
      if (item.regions.some((reg: OcrRegion) => reg.id === r.id)) {
        return { ...r, approved: AegeanApproved };
      }
      return r;
    }));

    if (activeItem && activeItem.id === item.id) {
      setActiveItem((prev: RenderItem | null) => prev ? { ...prev, approved: AegeanApproved } : null);
    }

    const promises = item.regions.map(async (region: OcrRegion) => {
      try {
        const res = await safeFetch(`/api/ocr-regions/${region.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${user.token}`
          },
          body: JSON.stringify({ approved: AegeanApproved })
        });
        if (!res.ok) {
          throw new Error('Failed to update approval on server');
        }
      } catch (err) {
        console.error('Error updating approval status:', err);
      }
    });

    await Promise.all(promises);

    // Refresh conversations state from backend
    if (selectedPage) {
      safeFetch(`/api/images/${selectedPage.imageId}`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(res => res.json())
      .then(data => {
        setConversations(data.conversations || []);
      })
      .catch(err => console.error(err));
    }
  };

  const handleSaveEdit = async () => {
    if (!activeItem) return;
    
    const lines = editText.split('\n');
    const promises = activeItem.regions.map(async (region: OcrRegion, idx: number) => {
      const newText = lines[idx] !== undefined ? lines[idx] : '';
      
      setOcrRegions(prev => prev.map(r => {
        if (r.id === region.id) {
          return {
            ...r,
            ...(showTranslations ? { translatedText: newText } : { text: newText })
          };
        }
        return r;
      }));

      const body: { text?: string; translatedText?: string } = {};
      if (showTranslations) {
        body.translatedText = newText;
      } else {
        body.text = newText;
      }

      try {
        const res = await safeFetch(`/api/ocr-regions/${region.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${user.token}`
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          throw new Error('Failed to save edit on server');
        }
      } catch (err) {
        console.error('Error saving region edit:', err);
      }
    });

    setIsEditingRegion(false);
    await Promise.all(promises);

    // Refresh conversations state from backend
    if (selectedPage) {
      safeFetch(`/api/images/${selectedPage.imageId}`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(res => res.json())
      .then(data => {
        setConversations(data.conversations || []);
      })
      .catch(err => console.error(err));
    }
  };

  const handleRedoRegion = async (r: OcrRegion, forceType?: 'ocr' | 'translation') => {
    setIsRedoing(true);
    const type = forceType || (showTranslations ? 'translation' : 'ocr');

    try {
      const res = await safeFetch(`/api/ocr-regions/${r.id}/redo?type=${type}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`
        }
      });
      
      if (!res.ok) {
        throw new Error('Redo request failed');
      }

      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        if (attempts > 20) {
          clearInterval(interval);
          setIsRedoing(false);
          alert('Redo timed out. Please try again.');
          return;
        }

        try {
          const checkRes = await safeFetch(`/api/images/${selectedPage?.imageId}`, {
            headers: { 'Authorization': `Bearer ${user.token}` }
          });
          if (checkRes.ok) {
            const data = await checkRes.json();
            const regions: OcrRegion[] = data.ocrRegions || [];
            const freshRegion = regions.find(item => item.id === r.id);
            if (freshRegion) {
              const textChanged = type === 'translation'
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
                      regions: prev.regions.map((reg: OcrRegion) => reg.id === r.id ? freshRegion : reg)
                    };
                  });
                  setEditText(showTranslations ? (freshRegion.translatedText || '') : freshRegion.text);
                }
                setIsRedoing(false);
              }
            }
          }
        } catch (pollErr) {
          console.error('Polling error during redo:', pollErr);
        }
      }, 500);

    } catch (err) {
      console.error('Error redoing region:', err);
      setIsRedoing(false);
      alert('Failed to start redo job.');
    }
  };

  const handleRedoPageOcr = async () => {
    if (!selectedPage) return;
    setIsRedoingPageOcr(true);
    try {
      const res = await safeFetch(`/api/images/${selectedPage.imageId}/redo?type=ocr`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      if (res.ok) {
        alert('Page OCR & Translation redo job enqueued successfully.');
      } else {
        alert('Failed to enqueue Page OCR redo job.');
      }
    } catch (err) {
      console.error(err);
      alert('Error triggering redo job.');
    } finally {
      setIsRedoingPageOcr(false);
    }
  };

  const handleRedoPageTranslation = async () => {
    if (!selectedPage) return;
    setIsRedoingPageTranslation(true);
    try {
      const res = await safeFetch(`/api/images/${selectedPage.imageId}/redo?type=translation`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      if (res.ok) {
        alert('Page Translation redo job enqueued successfully.');
      } else {
        alert('Failed to enqueue Page Translation redo job.');
      }
    } catch (err) {
      console.error(err);
      alert('Error triggering redo job.');
    } finally {
      setIsRedoingPageTranslation(false);
    }
  };

  const handleImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setImageDims({
      w: e.currentTarget.naturalWidth,
      h: e.currentTarget.naturalHeight
    });
  };

  if (isLoadingPageDetails || !selectedPage) {
    return (
      <div className="reader-container-nhentai" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="spinner"></div>
        <p>Loading page details...</p>
      </div>
    );
  }

  return (
    <div className="reader-container-nhentai">
      {/* Top Navbar */}
      <div className="reader-navbar-nhentai" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button 
            className="reader-nav-btn back-btn"
            onClick={() => navigate(`/chapters/${selectedChapter ? selectedChapter.id : ''}/${selectedChapter ? toSlug(selectedChapter.title || `chapter-${selectedChapter.chapterNumber}`) : ''}`)}
            title="Back to Chapter"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"></line>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
          </button>
          
          <button 
            className={`reader-nav-btn gear-btn ${showLeftSidebar ? 'active' : ''}`}
            onClick={() => setShowLeftSidebar(prev => !prev)}
            title="Toggle Global Controls (Left Sidebar)"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
        </div>

        <div style={{ fontWeight: 600, fontSize: '14px', fontFamily: 'var(--font-display)', color: 'var(--text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%' }}>
          {selectedSeries ? selectedSeries.title : 'Series'} &mdash; Chapter {selectedChapter?.chapterNumber}
        </div>

        <button 
          className={`reader-nav-btn gear-btn ${showRightSidebar ? 'active' : ''}`}
          onClick={() => setShowRightSidebar(prev => !prev)}
          title="Toggle Property Inspector (Right Sidebar)"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="15" y1="3" x2="15" y2="21" />
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
                    onChange={e => setShowPanels(e.target.checked)} 
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
                    onChange={e => setShowOcr(e.target.checked)} 
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
                    onChange={e => setCleanScanlationView(e.target.checked)} 
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
                    onChange={e => setGroupByConversation(e.target.checked)} 
                  />
                  <span className="slider"></span>
                </label>
              </div>
            </div>

            {/* Zoom Controls Section */}
            <div className="panel-section">
              <div className="panel-section-title">Zoom & View</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <input 
                  type="range" 
                  min="0.5" 
                  max="3.0" 
                  step="0.1" 
                  value={zoom} 
                  onChange={e => setZoom(parseFloat(e.target.value))} 
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: '12px', fontWeight: 'bold', minWidth: '40px', textAlign: 'right' }}>
                  {displayedZoom}%
                </span>
              </div>
              <div style={{ display: 'flex', gap: '6px', width: '100%', marginBottom: '8px' }}>
                <button 
                  className={`btn ${fitMode === 'page' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ flex: 1, fontSize: '10px', padding: '4px' }}
                  onClick={() => setFitMode('page')}
                >
                  Page
                </button>
                <button 
                  className={`btn ${fitMode === 'width' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ flex: 1, fontSize: '10px', padding: '4px' }}
                  onClick={() => setFitMode('width')}
                >
                  Width
                </button>
                <button 
                  className={`btn ${fitMode === 'height' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ flex: 1, fontSize: '10px', padding: '4px' }}
                  onClick={() => setFitMode('height')}
                >
                  Height
                </button>
              </div>
              <button 
                className="btn btn-secondary" 
                style={{ width: '100%', fontSize: '11px', padding: '6px' }} 
                onClick={() => { setZoom(1.0); setFitMode('page'); }}
                disabled={zoom === 1.0 && fitMode === 'page'}
              >
                Reset Zoom
              </button>
            </div>

            {/* Page & Chapter Navigation */}
            <div className="panel-section">
              <div className="panel-section-title">Navigation</div>
              
              <div className="reader-page-controls-nhentai" style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px', gap: '6px' }}>
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
                
                <span className="reader-page-indicator-nhentai" style={{ margin: '0 4px', fontSize: '12px' }}>
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
              <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                <button 
                  className="btn btn-secondary" 
                  style={{ flex: 1, fontSize: '11px', padding: '6px' }}
                  onClick={() => prevChapter && navigateToChapter(prevChapter)}
                  disabled={!prevChapter}
                  title={prevChapter ? `Go to Chapter ${prevChapter.chapterNumber}` : 'No previous chapter'}
                >
                  &larr; Prev Ch
                </button>
                <button 
                  className="btn btn-secondary" 
                  style={{ flex: 1, fontSize: '11px', padding: '6px' }}
                  onClick={() => nextChapter && navigateToChapter(nextChapter)}
                  disabled={!nextChapter}
                  title={nextChapter ? `Go to Chapter ${nextChapter.chapterNumber}` : 'No next chapter'}
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
              overflow: 'hidden', 
              cursor: isDraggingCanvas ? 'grabbing' : 'grab',
              touchAction: isTouchScreen ? 'none' : 'auto'
            }}
          >
            <div 
              className="manga-canvas-wrapper"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: 'center center',
                position: 'relative',
                transition: isDraggingCanvas ? 'none' : 'transform 0.15s ease-out',
                userSelect: 'none'
              }}
            >
              <img 
                ref={imgRef}
                src={selectedPage.url} 
                alt={`Page ${selectedPage.pageNumber}`} 
                className="reader-image" 
                onLoad={handleImgLoad}
                style={{
                  width: fitMode === 'width' ? '100%' : 'auto',
                  height: fitMode === 'height' ? '85vh' : 'auto',
                  maxHeight: fitMode === 'page' ? '80vh' : 'none',
                  maxWidth: fitMode === 'page' ? '100%' : 'none'
                }}
                draggable={false}
              />
              <svg 
                className="svg-overlay"
                viewBox={`0 0 ${imageDims.w} ${imageDims.h}`}
                style={{ pointerEvents: 'auto' }}
              >
                {showPanels && !cleanScanlationView && panels.map(p => (
                  <rect 
                    key={p.id}
                    x={p.bboxX}
                    y={p.bboxY}
                    width={p.bboxW}
                    height={p.bboxH}
                    className="svg-panel-box"
                    style={{ pointerEvents: 'none' }}
                  />
                ))}

                {showOcr && !cleanScanlationView && renderItems.map((item) => {
                  const isSelected = selectedItem?.id === item.id;
                  const isApproved = item.approved;
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
                      style={{ cursor: 'pointer' }}
                    >
                      <rect 
                        x={item.bboxX}
                        y={item.bboxY}
                        width={item.bboxW}
                        height={item.bboxH}
                        className={item.isConversation ? "svg-conv-box" : "svg-ocr-box"}
                        style={{ 
                          fill: isSelected 
                            ? (item.isConversation ? 'var(--conversation-glow-selected)' : 'var(--primary-glow-selected)') 
                            : isApproved 
                              ? (item.isConversation ? 'var(--conversation-glow-approved)' : 'var(--primary-glow-approved)') 
                              : (item.isConversation ? 'var(--conversation-glow)' : 'var(--success-glow)'),
                          stroke: isSelected 
                            ? (item.isConversation ? 'var(--conversation)' : 'var(--primary)') 
                            : isApproved 
                              ? (item.isConversation ? 'var(--conversation)' : 'var(--primary)') 
                              : (item.isConversation ? 'var(--conversation)' : 'var(--success)'),
                          strokeWidth: isSelected || isApproved ? 2.5 : 1.5
                        }}
                      />
                      <g transform={`translate(${item.bboxX + 10}, ${item.bboxY + 10})`}>
                        <circle 
                          cx="0" 
                          cy="0" 
                          r="8" 
                          fill={isSelected 
                            ? (item.isConversation ? 'var(--conversation)' : 'var(--primary)') 
                            : isApproved 
                              ? (item.isConversation ? 'var(--conversation)' : 'var(--primary)') 
                              : (item.isConversation ? 'var(--conversation)' : 'var(--success)')} 
                        />
                        <text 
                          x="0" 
                          y="0" 
                          className="bubble-text-tag"
                          style={{
                            textAnchor: 'middle',
                            dominantBaseline: 'central',
                            fontSize: '9px',
                            fontWeight: 'bold',
                            fill: '#ffffff'
                          }}
                        >
                          {isApproved ? '✓' : (item.regions[0]?.bubbleReadingOrder || 1)}
                        </text>
                      </g>
                    </g>
                  );
                })}

                {layers.map((lData) => {
                  if (!lData.layer.visible) return null;
                  return lData.elements.map((element) => {
                    if (!element.visible) return null;

                    const isSelected = selectedItem?.id === element.id && selectedItem?.isLayerElement;
                    
                    // Run text fitting
                    let fontSize: number;
                    let overflow: boolean;

                    if (element.autoSize) {
                      const fit = fitTextInBox(
                        element.text || '',
                        element.maxWidth || 100,
                        element.maxHeight || 100,
                        element.font || 'Comic Neue',
                        element.size || 16
                      );
                      fontSize = fit.fontSize;
                      overflow = fit.overflow;
                    } else {
                      const fit = fitTextInBox(
                        element.text || '',
                        element.maxWidth || 100,
                        element.maxHeight || 100,
                        element.font || 'Comic Neue',
                        element.size || 16
                      );
                      fontSize = element.size || 16;
                      const totalHeight = fit.lines.length * fontSize * 1.2;
                      overflow = totalHeight > (element.maxHeight || 100);
                    }

                    const width = element.maxWidth || 100;
                    const height = element.maxHeight || 100;
                    const cx = element.x + width / 2;
                    const cy = element.y + height / 2;

                    // Support masking toggle via wordWrap field
                    const isMaskEnabled = cleanScanlationView || element.wordWrap;

                    return (
                      <g 
                        key={element.id}
                        transform={`rotate(${element.rotation || 0}, ${cx}, ${cy})`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedItem({ ...element, isLayerElement: true });
                        }}
                        style={{ cursor: 'pointer' }}
                      >
                        {/* Backdrop Mask */}
                        {isMaskEnabled && (
                          <rect 
                            x={element.x}
                            y={element.y}
                            width={width}
                            height={height}
                            fill={element.backgroundColor || '#ffffff'}
                            stroke="none"
                          />
                        )}

                        {/* Developer/Editor borders */}
                        {!cleanScanlationView && (
                          <rect 
                            x={element.x}
                            y={element.y}
                            width={width}
                            height={height}
                            fill="transparent"
                            stroke={isSelected ? 'var(--primary)' : 'rgba(139, 92, 246, 0.4)'}
                            strokeWidth={isSelected ? 2 : 1}
                            strokeDasharray={isSelected ? 'none' : '4 4'}
                          />
                        )}

                        {/* Interactive overlay rect for drag moving */}
                        {!cleanScanlationView && (
                          <rect
                            x={element.x}
                            y={element.y}
                            width={width}
                            height={height}
                            fill="transparent"
                            style={{ cursor: 'move' }}
                            onMouseDown={(e) => {
                              handleElementDragStart(e, element, 'move');
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
                            fill="transparent"
                            stroke="#ef4444"
                            strokeWidth="1.5"
                            strokeDasharray="2 2"
                          />
                        )}

                        {/* Drag and Resize Handles */}
                        {isSelected && !cleanScanlationView && (
                          <>
                            {/* Top-Left Handle */}
                            <rect
                              x={element.x - 4}
                              y={element.y - 4}
                              width={8}
                              height={8}
                              fill="var(--primary)"
                              stroke="#ffffff"
                              strokeWidth={1.5}
                              style={{ cursor: 'nwse-resize' }}
                              onMouseDown={(e) => handleElementDragStart(e, element, 'resize-tl')}
                            />
                            {/* Top-Right Handle */}
                            <rect
                              x={element.x + width - 4}
                              y={element.y - 4}
                              width={8}
                              height={8}
                              fill="var(--primary)"
                              stroke="#ffffff"
                              strokeWidth={1.5}
                              style={{ cursor: 'nesw-resize' }}
                              onMouseDown={(e) => handleElementDragStart(e, element, 'resize-tr')}
                            />
                            {/* Bottom-Left Handle */}
                            <rect
                              x={element.x - 4}
                              y={element.y + height - 4}
                              width={8}
                              height={8}
                              fill="var(--primary)"
                              stroke="#ffffff"
                              strokeWidth={1.5}
                              style={{ cursor: 'nesw-resize' }}
                              onMouseDown={(e) => handleElementDragStart(e, element, 'resize-bl')}
                            />
                            {/* Bottom-Right Handle */}
                            <rect
                              x={element.x + width - 4}
                              y={element.y + height - 4}
                              width={8}
                              height={8}
                              fill="var(--primary)"
                              stroke="#ffffff"
                              strokeWidth={1.5}
                              style={{ cursor: 'nwse-resize' }}
                              onMouseDown={(e) => handleElementDragStart(e, element, 'resize-br')}
                            />
                          </>
                        )}

                        <foreignObject
                          x={element.x}
                          y={element.y}
                          width={width}
                          height={height}
                          style={{ pointerEvents: 'none' }}
                        >
                          <div
                            style={{
                              width: '100%',
                              height: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              textAlign: 'center',
                              padding: '4px',
                              boxSizing: 'border-box',
                              overflow: 'hidden'
                            }}
                          >
                            <div
                              style={{
                                fontFamily: `"${element.font || 'Comic Neue'}", sans-serif`,
                                fontSize: `${fontSize}px`,
                                fontWeight: element.fontWeight || 'normal',
                                fontStyle: element.fontStyle || 'normal',
                                color: element.textColor || '#000000',
                                lineHeight: '1.2',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                textAlign: 'center',
                                width: '100%'
                              }}
                            >
                              {element.text}
                            </div>
                          </div>
                        </foreignObject>
                      </g>
                    );
                  });
                })}
              </svg>

              {/* Popover overlay tooltip */}
              {popoverOpen && activeItem && (() => {
                const showBelow = activeItem.bboxY < 150;
                const popoverWidth = 240;
                const halfWidth = popoverWidth / 2;
                const clampedX = imageDims.w > popoverWidth 
                  ? Math.max(halfWidth, Math.min(imageDims.w - halfWidth, activeItem.bboxX + activeItem.bboxW / 2))
                  : imageDims.w / 2;
                return (
                  <div 
                    className="bubble-popover glass"
                    onMouseEnter={handleMouseEnterPopover}
                    onMouseLeave={handleMouseLeavePopover}
                    style={{
                      position: 'absolute',
                      left: `${(clampedX / imageDims.w) * 100}%`,
                      top: showBelow 
                        ? `${((activeItem.bboxY + activeItem.bboxH) / imageDims.h) * 100}%`
                        : `${(activeItem.bboxY / imageDims.h) * 100}%`,
                      transform: `${showBelow ? 'translate(-50%, 0%)' : 'translate(-50%, -100%)'} scale(${1 / zoom})`,
                      transformOrigin: showBelow ? 'top center' : 'bottom center',
                      marginTop: showBelow ? '12px' : '-12px',
                      zIndex: 100,
                      padding: '12px',
                      width: '240px',
                      borderRadius: '8px',
                      boxShadow: '0 10px 15px -3px rgba(0,0,0,0.15), 0 4px 6px -2px rgba(0,0,0,0.05)',
                      border: '1px solid var(--border-color)',
                      backgroundColor: 'var(--bg-surface)',
                      color: 'var(--text-main)',
                      fontSize: '13px',
                      pointerEvents: 'auto'
                    }}
                  >
                    {isRedoing ? (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '12px 0' }}>
                        <div className="spinner" style={{ width: '24px', height: '24px', margin: '0 auto' }}></div>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Running Redo Job...</span>
                      </div>
                    ) : isEditingRegion ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <textarea
                          style={{
                            width: '100%',
                            minHeight: '80px',
                            backgroundColor: 'var(--bg-input, rgba(0,0,0,0.05))',
                            border: '1px solid var(--primary)',
                            borderRadius: '4px',
                            color: 'var(--text-main)',
                            padding: '6px',
                            fontSize: '13px',
                            resize: 'vertical',
                            outline: 'none',
                            fontFamily: 'inherit'
                          }}
                          value={editText}
                          onChange={e => setEditText(e.target.value)}
                          autoFocus
                        />
                        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                          <button 
                            className="btn btn-secondary" 
                            style={{ padding: '4px 8px', fontSize: '11px' }}
                            onClick={() => setIsEditingRegion(false)}
                          >
                            Cancel
                          </button>
                          <button 
                            className="btn btn-primary" 
                            style={{ padding: '4px 8px', fontSize: '11px' }}
                            onClick={handleSaveEdit}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ wordBreak: 'break-word', lineHeight: '1.4', maxHeight: '120px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                          {showTranslations ? (getCombinedText(activeItem, true) || 'No translation yet.') : getCombinedText(activeItem, false)}
                        </div>
                        
                        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                            {showTranslations ? 'Translated' : 'Original'} ({activeItem.regions[0]?.detectedLanguage})
                          </span>
                          <div style={{ display: 'flex', gap: '10px' }}>
                            <button
                              onClick={() => handleToggleApprove(activeItem)}
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                color: activeItem.approved ? 'var(--primary)' : 'var(--text-dim)',
                                padding: '2px',
                                display: 'flex',
                                alignItems: 'center'
                              }}
                              title={activeItem.approved ? 'Approved' : 'Approve'}
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12"></polyline>
                              </svg>
                            </button>

                            <button
                              onClick={() => {
                                setIsEditingRegion(true);
                                setEditText(getCombinedText(activeItem, showTranslations));
                              }}
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                color: 'var(--text-dim)',
                                padding: '2px',
                                display: 'flex',
                                alignItems: 'center'
                              }}
                              title="Edit text"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                              </svg>
                            </button>

                            {activeRegion && (
                              <>
                                <button
                                  onClick={() => handleRedoRegion(activeRegion, 'ocr')}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    color: 'var(--text-dim)',
                                    padding: '2px',
                                    display: 'flex',
                                    alignItems: 'center'
                                  }}
                                  title="Re-run OCR"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                                  </svg>
                                </button>

                                <button
                                  onClick={() => handleRedoRegion(activeRegion, 'translation')}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    color: 'var(--text-dim)',
                                    padding: '2px',
                                    display: 'flex',
                                    alignItems: 'center'
                                  }}
                                  title="Re-translate text"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M2 5h12M7 2v3M7 5c0 4.4-3.6 8-8 8M5 9c-.9 2.3-2.9 4-5 4M14 18h8M18 11l4 10M18 11l-4 10"/>
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
                <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', padding: '16px 0 24px', borderBottom: '1px solid var(--border-color)', marginBottom: '24px' }}>
                  Select an OCR region or a text layer to inspect and edit details.
                </div>
                
                 {/* Translation Layers Section */}
                 <div className="panel-section">
                   <div className="panel-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                     <span>Layers</span>
                     <div style={{ display: 'flex', gap: '4px' }}>
                       <button 
                         className="btn btn-secondary"
                         style={{ padding: '2px 6px', fontSize: '10px' }}
                         onClick={handleCreateTranslationLayer}
                         title="Add Translation Layer"
                       >
                         + TL
                       </button>
                       <button 
                         className="btn btn-secondary"
                         style={{ padding: '2px 6px', fontSize: '10px' }}
                         onClick={handleCreateSfxLayer}
                         title="Add SFX Layer"
                       >
                         + SFX
                       </button>
                     </div>
                   </div>
                   
                   {layers.length === 0 ? (
                     <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '4px 0' }}>
                       No active layers.
                     </div>
                   ) : (
                     layers.map(lData => {
                       const isActive = lData.layer.id === activeLayerId;
                       return (
                         <div 
                           key={lData.layer.id} 
                           className="overlay-toggle" 
                           onClick={() => setActiveLayerId(lData.layer.id)}
                           style={{ 
                             padding: '6px 8px', 
                             border: isActive ? '1px solid var(--primary)' : '1px solid var(--border-color)', 
                             borderRadius: '6px', 
                             marginBottom: '6px',
                             backgroundColor: isActive ? 'var(--primary-glow)' : 'rgba(255,255,255,0.02)',
                             cursor: 'pointer',
                             boxShadow: isActive ? '0 0 8px var(--primary-glow)' : 'none'
                           }}
                         >
                           <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                             <span style={{ fontSize: '12px', fontWeight: isActive ? 700 : 600, color: isActive ? 'var(--primary-hover)' : 'inherit' }}>
                               {lData.layer.type === 'translation' 
                                 ? `Translation (${lData.layer.targetLanguage?.toUpperCase() || 'EN'})` 
                                 : lData.layer.type === 'sfx'
                                   ? 'SFX Layer'
                                   : `Layer (${lData.layer.type})`}
                             </span>
                             <span style={{ fontSize: '9px', color: 'var(--text-dim)' }}>
                               {lData.elements.length} elements
                             </span>
                           </div>
                           <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }} onClick={e => e.stopPropagation()}>
                             <button
                               onClick={() => handleToggleLayerVisibility(lData.layer.id)}
                               style={{
                                 background: 'none',
                                 border: 'none',
                                 color: lData.layer.visible ? 'var(--primary)' : 'var(--text-muted)',
                                 cursor: 'pointer',
                                 padding: '2px',
                                 display: 'flex',
                                 alignItems: 'center'
                               }}
                               title="Toggle layer visibility"
                             >
                               {lData.layer.visible ? (
                                 <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                   <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                                   <circle cx="12" cy="12" r="3"></circle>
                                 </svg>
                               ) : (
                                 <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                   <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                                   <line x1="1" y1="1" x2="23" y2="23"></line>
                                 </svg>
                               )}
                             </button>
 
                             <button
                               onClick={() => handleDeleteLayer(lData.layer.id)}
                               style={{
                                 background: 'none',
                                 border: 'none',
                                 color: 'var(--text-muted)',
                                 cursor: 'pointer',
                                 padding: '2px',
                                 display: 'flex',
                                 alignItems: 'center'
                               }}
                               title="Delete layer"
                             >
                               <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
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
                   <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                     <button 
                       className="btn btn-secondary"
                       style={{ flex: 1, padding: '8px', fontSize: '11px', fontWeight: 600 }}
                       onClick={() => handleAddNewElement('text')}
                       disabled={!activeLayerId}
                       title={activeLayerId ? "Add a new text element to active layer" : "Select or create a layer first"}
                     >
                       💬 Add Text
                     </button>
                     <button 
                       className="btn btn-secondary"
                       style={{ flex: 1, padding: '8px', fontSize: '11px', fontWeight: 600 }}
                       onClick={() => handleAddNewElement('mask')}
                       disabled={!activeLayerId}
                       title={activeLayerId ? "Add a new background mask to active layer" : "Select or create a layer first"}
                     >
                       ⬜ Add Mask
                     </button>
                   </div>
                   <button 
                     className="btn btn-secondary sidebar-action-btn"
                     style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
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
                    style={{ width: '100%', marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                  >
                    {isRedoingPageOcr ? <div className="spinner-mini"></div> : null}
                    Redo Page OCR
                  </button>
                  <button 
                    className="btn btn-secondary sidebar-action-btn"
                    onClick={handleRedoPageTranslation}
                    disabled={isRedoingPageTranslation}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                  >
                    {isRedoingPageTranslation ? <div className="spinner-mini"></div> : null}
                    Redo Page Translation
                  </button>
                </div>

                {/* Export Section */}
                <div className="panel-section" style={{ paddingBottom: '40px' }}>
                  <div className="panel-section-title">Export</div>
                  <button
                    className="btn btn-secondary sidebar-action-btn"
                    onClick={handleExportPng}
                    style={{ width: '100%', marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                  >
                    Export Page (PNG)
                  </button>
                  <button
                    className="btn btn-secondary sidebar-action-btn"
                    onClick={handleExportZip}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                  >
                    Export Project (ZIP)
                  </button>
                </div>
              </>
            )}

            {selectedItem && selectedItem.isLayerElement && (
              <div className="ocr-detail-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div className="panel-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: 0 }}>
                  <span>Element Inspector</span>
                  <button 
                    onClick={() => setSelectedItem(null)}
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--border-color)',
                      color: 'var(--text-main)',
                      borderRadius: '6px',
                      padding: '4px 8px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontWeight: 600,
                    }}
                  >
                    Deselect
                  </button>
                </div>
                
                {/* Text Content */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-muted)' }}>Text Content</label>
                  <textarea
                    style={{
                      width: '100%',
                      minHeight: '80px',
                      backgroundColor: 'var(--bg-input, rgba(0,0,0,0.05))',
                      border: '1px solid var(--border-color)',
                      borderRadius: '4px',
                      color: 'var(--text-main)',
                      padding: '6px',
                      fontSize: '13px',
                      resize: 'vertical',
                      outline: 'none',
                      fontFamily: 'inherit'
                    }}
                    value={selectedItem.text || ''}
                    onChange={e => handleUpdateSelectedElement({ text: e.target.value })}
                  />
                </div>

                {/* Positioning Coordinates Row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-muted)' }}>X Position</label>
                    <input 
                      type="number"
                      className="form-input"
                      style={{ padding: '6px 10px', fontSize: '13px' }}
                      value={selectedItem.x}
                      onChange={e => handleUpdateSelectedElement({ x: parseFloat(e.target.value) || 0 })}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-muted)' }}>Y Position</label>
                    <input 
                      type="number"
                      className="form-input"
                      style={{ padding: '6px 10px', fontSize: '13px' }}
                      value={selectedItem.y}
                      onChange={e => handleUpdateSelectedElement({ y: parseFloat(e.target.value) || 0 })}
                    />
                  </div>
                </div>

                {/* Dimensions Row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-muted)' }}>Max Width</label>
                    <input 
                      type="number"
                      className="form-input"
                      style={{ padding: '6px 10px', fontSize: '13px' }}
                      value={selectedItem.maxWidth || 0}
                      onChange={e => handleUpdateSelectedElement({ maxWidth: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-muted)' }}>Max Height</label>
                    <input 
                      type="number"
                      className="form-input"
                      style={{ padding: '6px 10px', fontSize: '13px' }}
                      value={selectedItem.maxHeight || 0}
                      onChange={e => handleUpdateSelectedElement({ maxHeight: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                </div>

                 {/* Font & Style settings */}
                 <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                   <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                     <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-muted)' }}>Font Family</label>
                     <select
                       className="form-input"
                       style={{ padding: '4px 8px', fontSize: '13px', height: '38px', backgroundColor: 'var(--bg-surface)' }}
                       value={selectedItem.font || 'Comic Neue'}
                       onChange={e => handleUpdateSelectedElement({ font: e.target.value })}
                     >
                       <option value="Comic Neue">Comic Neue</option>
                       <option value="Bangers">Bangers</option>
                       <option value="Arial">Arial</option>
                       <option value="Courier New">Courier New</option>
                     </select>
                   </div>
                   <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                     <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-muted)' }}>Font Size (pt)</label>
                     <input 
                       type="number"
                       className="form-input"
                       style={{ padding: '6px 10px', fontSize: '13px' }}
                       value={selectedItem.size || 16}
                       onChange={e => handleUpdateSelectedElement({ size: parseFloat(e.target.value) || 12 })}
                     />
                   </div>
                 </div>

                 {/* Font Weight & Style Row */}
                 <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                   <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                     <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-muted)' }}>Font Weight</label>
                     <select
                       className="form-input"
                       style={{ padding: '4px 8px', fontSize: '13px', height: '38px', backgroundColor: 'var(--bg-surface)' }}
                       value={selectedItem.fontWeight || 'normal'}
                       onChange={e => handleUpdateSelectedElement({ fontWeight: e.target.value })}
                     >
                       <option value="normal">Normal</option>
                       <option value="bold">Bold</option>
                     </select>
                   </div>
                   <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                     <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-muted)' }}>Font Style</label>
                     <select
                       className="form-input"
                       style={{ padding: '4px 8px', fontSize: '13px', height: '38px', backgroundColor: 'var(--bg-surface)' }}
                       value={selectedItem.fontStyle || 'normal'}
                       onChange={e => handleUpdateSelectedElement({ fontStyle: e.target.value })}
                     >
                       <option value="normal">Normal</option>
                       <option value="italic">Italic</option>
                     </select>
                   </div>
                 </div>

                  {/* Mask Background Color (only relevant if clean background mask is enabled) */}
                  {selectedItem.wordWrap && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-muted)' }}>Mask Background Color</label>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <input 
                          type="color"
                          style={{ 
                            width: '40px', 
                            height: '38px', 
                            padding: '2px', 
                            border: '1px solid var(--border-color)', 
                            borderRadius: '6px',
                            backgroundColor: 'transparent',
                            cursor: 'pointer' 
                          }}
                          value={normalizeHexColor(selectedItem.backgroundColor)}
                          onChange={e => handleUpdateSelectedElement({ backgroundColor: e.target.value })}
                        />
                        <input 
                          type="text"
                          className="form-input"
                          style={{ flex: 1, padding: '6px 10px', fontSize: '13px', fontFamily: 'monospace' }}
                          placeholder="#ffffff"
                          value={selectedItem.backgroundColor || ''}
                          onChange={e => handleUpdateSelectedElement({ backgroundColor: e.target.value })}
                        />
                        <button 
                          className="btn btn-secondary"
                          style={{ padding: '8px 12px', fontSize: '13px' }}
                          onClick={() => handleLaunchEyeDropper('backgroundColor')}
                          title="Color Dropper"
                        >
                          🧪
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Text Color (only relevant if it is a text-bearing element) */}
                  {selectedItem.text !== undefined && selectedItem.text !== null && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-muted)' }}>Text Color</label>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <input 
                          type="color"
                          style={{ 
                            width: '40px', 
                            height: '38px', 
                            padding: '2px', 
                            border: '1px solid var(--border-color)', 
                            borderRadius: '6px',
                            backgroundColor: 'transparent',
                            cursor: 'pointer' 
                          }}
                          value={normalizeHexTextColor(selectedItem.textColor)}
                          onChange={e => handleUpdateSelectedElement({ textColor: e.target.value })}
                        />
                        <input 
                          type="text"
                          className="form-input"
                          style={{ flex: 1, padding: '6px 10px', fontSize: '13px', fontFamily: 'monospace' }}
                          placeholder="#000000"
                          value={selectedItem.textColor || ''}
                          onChange={e => handleUpdateSelectedElement({ textColor: e.target.value })}
                        />
                        <button 
                          className="btn btn-secondary"
                          style={{ padding: '8px 12px', fontSize: '13px' }}
                          onClick={() => handleLaunchEyeDropper('textColor')}
                          title="Color Dropper"
                        >
                          🧪
                        </button>
                      </div>
                    </div>
                  )}

                 {/* Rotation Slider */}
                 <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                   <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-muted)' }}>Rotation ({selectedItem.rotation || 0}°)</label>
                   <input 
                     type="range"
                     min="0"
                     max="360"
                     value={selectedItem.rotation || 0}
                     onChange={e => handleUpdateSelectedElement({ rotation: parseFloat(e.target.value) || 0 })}
                     style={{ width: '100%' }}
                   />
                 </div>

                 {/* Checkboxes Row */}
                 <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', borderTop: '1px solid var(--border-color)', paddingTop: '10px' }}>
                   <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                     <input 
                       type="checkbox"
                       id="autoSizeCheck"
                       checked={selectedItem.autoSize}
                       onChange={e => handleUpdateSelectedElement({ autoSize: e.target.checked })}
                     />
                     <label htmlFor="autoSizeCheck" style={{ fontSize: '12px', cursor: 'pointer' }}>Auto-size text to fit bubble</label>
                   </div>

                   <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                     <input 
                       type="checkbox"
                       id="visibleCheck"
                       checked={selectedItem.visible}
                       onChange={e => handleUpdateSelectedElement({ visible: e.target.checked })}
                     />
                     <label htmlFor="visibleCheck" style={{ fontSize: '12px', cursor: 'pointer' }}>Visible</label>
                   </div>
                   
                   <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                     <input 
                       type="checkbox"
                       id="maskCheck"
                       checked={selectedItem.wordWrap}
                       onChange={e => handleUpdateSelectedElement({ wordWrap: e.target.checked })}
                     />
                     <label htmlFor="maskCheck" style={{ fontSize: '12px', cursor: 'pointer' }}>Clean background mask</label>
                   </div>
                 </div>

                 {/* Action Buttons */}
                 <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                   <button
                     className="btn btn-primary"
                     style={{ flex: 1, padding: '8px' }}
                     onClick={() => handleSaveElementChanges(selectedItem)}
                   >
                     Save
                   </button>
                   <button
                     className="btn btn-secondary"
                     style={{ flex: 1, padding: '8px', borderColor: 'var(--error, #ef4444)', color: 'var(--error, #ef4444)' }}
                     onClick={() => handleDeleteElement(selectedItem.id)}
                   >
                     Delete
                   </button>
                 </div>
              </div>
            )}

            {selectedItem && !selectedItem.isLayerElement && (
              <div className="ocr-detail-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div className="panel-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: 0 }}>
                  <span>{selectedItem.isConversation ? 'Conversation Inspector' : 'Region Inspector'}</span>
                  <button 
                    onClick={() => setSelectedItem(null)}
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--border-color)',
                      color: 'var(--text-main)',
                      borderRadius: '6px',
                      padding: '4px 8px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontWeight: 600,
                    }}
                  >
                    Deselect
                  </button>
                </div>
                
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '4px 0 8px' }}>
                  <span className="meta-badge" style={{ backgroundColor: 'var(--primary-glow)', color: 'var(--primary-hover)', borderColor: 'var(--primary)' }}>
                    {selectedItem.isConversation ? `Conv #${selectedItem.regions[0]?.bubbleReadingOrder}` : `Bubble #${selectedItem.regions[0]?.bubbleReadingOrder}`}
                  </span>
                  <span className="meta-badge" style={{ backgroundColor: 'var(--success-glow)', color: 'var(--success)' }}>
                    {selectedItem.regions[0]?.detectedLanguage || 'unknown'}
                  </span>
                  {selectedItem.isConversation && (
                    <span className="meta-badge" style={{ textTransform: 'capitalize' }}>
                      {selectedItem.sceneType}
                    </span>
                  )}
                  {selectedItem.approved && (
                    <span className="meta-badge" style={{ backgroundColor: 'rgba(16, 185, 129, 0.15)', color: 'var(--success)', borderColor: 'var(--success)' }}>
                      Approved
                    </span>
                  )}
                </div>
                
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                  Position: x={selectedItem.bboxX}, y={selectedItem.bboxY} ({selectedItem.bboxW}x{selectedItem.bboxH})
                </div>
                
                <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {selectedItem.regions.map((reg: OcrRegion, idx: number) => (
                    <div key={reg.id} style={{ borderBottom: idx < selectedItem.regions.length - 1 ? '1px dashed var(--border-color)' : 'none', paddingBottom: '12px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase' }}>
                        Region #{idx + 1} Original
                      </div>
                      <div className="ocr-text-preview" style={{ marginBottom: '8px' }}>
                        {reg.text}
                      </div>

                      {reg.translatedText && (
                        <>
                          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase' }}>
                            Region #{idx + 1} Translation
                          </div>
                          <div className="ocr-text-preview" style={{ color: 'var(--primary-hover)', borderColor: 'var(--primary)' }}>
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
    </div>
  );
};
