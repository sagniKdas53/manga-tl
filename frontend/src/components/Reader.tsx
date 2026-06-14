import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { User, Chapter, Page, Panel, OcrRegion } from '../types';
import { safeFetch, toSlug } from '../utils';

interface ReaderProps {
  user: User;
  selectedChapter: Chapter | null;
  pages: Page[];
  theme: 'light' | 'dark';
}

export const Reader: React.FC<ReaderProps> = ({
  user,
  selectedChapter,
  pages,
  theme,
}) => {
  const navigate = useNavigate();
  const { pageNumber } = useParams<{ pageNumber: string }>();

  // Find selected page based on route param
  const curPageNum = parseInt(pageNumber || '1');
  const totalPages = pages.length;
  const selectedPage = pages.find(p => p.pageNumber === curPageNum);

  // Reader States
  const [panels, setPanels] = useState<Panel[]>([]);
  const [ocrRegions, setOcrRegions] = useState<OcrRegion[]>([]);
  const [selectedRegion, setSelectedRegion] = useState<OcrRegion | null>(null);
  const [imageDims, setImageDims] = useState({ w: 800, h: 1200 });
  const [showPanels, setShowPanels] = useState(true);
  const [showOcr, setShowOcr] = useState(true);
  const [showTranslations, setShowTranslations] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [isLoadingPageDetails, setIsLoadingPageDetails] = useState(false);
  const [loadedImageId, setLoadedImageId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1.0);
  const [isZoomExpanded, setIsZoomExpanded] = useState(true);

  // Pan & Drag States
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDraggingCanvas, setIsDraggingCanvas] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });

  // Popover States
  const [activeRegion, setActiveRegion] = useState<OcrRegion | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [isEditingRegion, setIsEditingRegion] = useState(false);
  const [editText, setEditText] = useState('');
  const [isRedoing, setIsRedoing] = useState(false);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null); // Fixed: Specify correct type to avoid strict 'any' warning

  // Fetch page details (panels, OCR regions) when page selection updates
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
        setSelectedRegion(null);
        setLoadedImageId(selectedPage.imageId);
        setIsLoadingPageDetails(false);
      })
      .catch(err => {
        console.error('Error loading page details:', err);
        setIsLoadingPageDetails(false);
      });
    }
  }, [selectedPage, loadedImageId, user.token]);

  // Reset pan/zoom on page changes
  useEffect(() => {
    setZoom(1.0);
    setPan({ x: 0, y: 0 });
    setSelectedRegion(null);
    setActiveRegion(null);
    setPopoverOpen(false);
  }, [pageNumber]);

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
        setSelectedRegion(null);
        setActiveRegion(null);
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
      (e.target as HTMLElement).closest('.bubble-popover') ||
      (e.target as HTMLElement).closest('.floating-reader-toolbar') ||
      (e.target as HTMLElement).closest('.floating-zoom-toolbar') ||
      (e.target as HTMLElement).closest('.delete-page-btn') ||
      (e.target as HTMLElement).closest('.reorder-controls')
    ) {
      return;
    }
    setIsDraggingCanvas(true);
    dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMoveCanvas = (e: React.MouseEvent) => {
    if (!isDraggingCanvas) return;
    setPan({
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y
    });
  };

  const handleMouseUpCanvas = () => {
    setIsDraggingCanvas(false);
  };

  // --- HOVER POPUP HANDLERS (useCallback resolved React Compiler Ref Warnings) ---
  const handleMouseEnterRegion = useCallback((r: OcrRegion) => {
    if (hideTimeout.current) clearTimeout(hideTimeout.current);
    setActiveRegion(r);
    setPopoverOpen(true);
    setEditText(showTranslations ? (r.translatedText || '') : r.text);
  }, [showTranslations]);

  const handleMouseLeaveRegion = useCallback(() => {
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

  // --- BUBBLE UPDATES ---
  const handleToggleApprove = async (r: OcrRegion) => {
    const updatedApproved = !r.approved;
    
    setOcrRegions(prev => prev.map(item => item.id === r.id ? { ...item, approved: updatedApproved } : item));
    if (activeRegion && activeRegion.id === r.id) {
      setActiveRegion(prev => prev ? { ...prev, approved: updatedApproved } : null);
    }

    try {
      const res = await safeFetch(`/api/ocr-regions/${r.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}`
        },
        body: JSON.stringify({ approved: updatedApproved })
      });
      if (!res.ok) {
        throw new Error('Failed to update approval on server');
      }
    } catch (err) {
      console.error('Error updating approval status:', err);
      // Revert local changes
      setOcrRegions(prev => prev.map(item => item.id === r.id ? { ...item, approved: !updatedApproved } : item));
      if (activeRegion && activeRegion.id === r.id) {
        setActiveRegion(prev => prev ? { ...prev, approved: !updatedApproved } : null);
      }
    }
  };

  const handleSaveEdit = async () => {
    if (!activeRegion) return;
    
    // Fixed: specify strict type on payload instead of any to satisfy lint warnings
    const body: { text?: string; translatedText?: string } = {};
    if (showTranslations) {
      body.translatedText = editText;
    } else {
      body.text = editText;
    }

    setOcrRegions(prev => prev.map(item => item.id === activeRegion.id ? { ...item, ...(showTranslations ? { translatedText: editText } : { text: editText }) } : item));
    setActiveRegion(prev => prev ? { ...prev, ...(showTranslations ? { translatedText: editText } : { text: editText }) } : null);
    setIsEditingRegion(false);

    try {
      const res = await safeFetch(`/api/ocr-regions/${activeRegion.id}`, {
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
      console.error('Error saving region text edit:', err);
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
                if (activeRegion && activeRegion.id === r.id) {
                  setActiveRegion(freshRegion);
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
      <div className="reader-navbar-nhentai">
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

        <div className="reader-page-controls-nhentai">
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
          
          <span className="reader-page-indicator-nhentai">
            <strong>{curPageNum}</strong> of {totalPages}
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

        <button 
          className={`reader-nav-btn gear-btn ${showSidebar ? 'active' : ''}`}
          onClick={() => setShowSidebar(prev => !prev)}
          title="Toggle Workspace Sidebar"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
      </div>

      {/* Main Workspace split */}
      <div className="reader-workspace-frame-nhentai">
        <div className="reader-main-nhentai">
          <div 
            className="reader-canvas-area"
            onMouseDown={handleMouseDownCanvas}
            onMouseMove={handleMouseMoveCanvas}
            onMouseUp={handleMouseUpCanvas}
            onMouseLeave={handleMouseUpCanvas}
            style={{ overflow: 'hidden', cursor: isDraggingCanvas ? 'grabbing' : 'grab' }}
          >
            <div 
              className="manga-canvas-wrapper"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px)`,
                position: 'relative',
                transition: isDraggingCanvas ? 'none' : 'transform 0.15s ease-out',
                userSelect: 'none'
              }}
            >
              <img 
                src={selectedPage.url} 
                alt={`Page ${selectedPage.pageNumber}`} 
                className="reader-image" 
                onLoad={handleImgLoad}
                style={{
                  maxHeight: `${80 * zoom}vh`,
                  maxWidth: `${100 * zoom}%`,
                  width: 'auto',
                  height: 'auto'
                }}
                draggable={false}
              />
              <svg 
                className="svg-overlay"
                viewBox={`0 0 ${imageDims.w} ${imageDims.h}`}
                style={{ pointerEvents: 'auto' }}
              >
                {showPanels && panels.map(p => (
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

                {showOcr && ocrRegions.map((r) => {
                  const isSelected = selectedRegion?.id === r.id;
                  const isApproved = r.approved === true;
                  return (
                    <g 
                      key={r.id} 
                      onClick={() => {
                        setSelectedRegion(r);
                        setActiveRegion(r);
                        setPopoverOpen(true);
                        setEditText(showTranslations ? (r.translatedText || '') : r.text);
                      }}
                      onMouseEnter={() => handleMouseEnterRegion(r)}
                      onMouseLeave={handleMouseLeaveRegion}
                      style={{ cursor: 'pointer' }}
                    >
                      <rect 
                        x={r.bboxX}
                        y={r.bboxY}
                        width={r.bboxW}
                        height={r.bboxH}
                        className="svg-ocr-box"
                        style={{ 
                          fill: isSelected 
                            ? 'var(--primary-glow-selected)' 
                            : isApproved 
                              ? 'var(--primary-glow-approved)' 
                              : 'var(--success-glow)',
                          stroke: isSelected 
                            ? 'var(--primary)' 
                            : isApproved 
                              ? 'var(--primary)' 
                              : 'var(--success)',
                          strokeWidth: isSelected || isApproved ? 2.5 : 1.5
                        }}
                      />
                      <g transform={`translate(${r.bboxX + 10}, ${r.bboxY + 10})`}>
                        <circle 
                          cx="0" 
                          cy="0" 
                          r="8" 
                          fill={isSelected 
                            ? 'var(--primary)' 
                            : isApproved 
                              ? 'var(--primary)' 
                              : 'var(--success)'} 
                        />
                        <text cx="0" cy="0" className="bubble-text-tag">
                          {isApproved ? '✓' : r.bubbleReadingOrder}
                        </text>
                      </g>
                    </g>
                  );
                })}

                {showTranslations && ocrRegions.map((r) => {
                  if (!r.translatedText) return null;

                  const overlayWidth = Math.max(r.bboxW, 120);
                  const overlayHeight = Math.max(r.bboxH, 80);
                  const overlayX = r.bboxX + (r.bboxW - overlayWidth) / 2;
                  const overlayY = r.bboxY + (r.bboxH - overlayHeight) / 2;

                  return (
                    <foreignObject
                      key={`trans-${r.id}`}
                      x={overlayX}
                      y={overlayY}
                      width={overlayWidth}
                      height={overlayHeight}
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
                          overflow: 'hidden',
                          pointerEvents: 'none'
                        }}
                      >
                        <div
                          style={{
                            background: theme === 'dark' ? 'rgba(15, 17, 23, 0.9)' : 'rgba(255, 255, 255, 0.95)',
                            color: theme === 'dark' ? '#ffffff' : '#0f172a',
                            fontSize: '11px',
                            fontWeight: 600,
                            lineHeight: '1.3',
                            padding: '4px 8px',
                            borderRadius: '6px',
                            border: theme === 'dark' ? '1px solid rgba(139, 92, 246, 0.3)' : '1px solid rgba(139, 92, 246, 0.2)',
                            boxShadow: '0 4px 10px rgba(0, 0, 0, 0.25)',
                            wordBreak: 'break-word',
                            maxWidth: '100%',
                            maxHeight: '100%',
                            overflowY: 'auto'
                          }}
                        >
                          {r.translatedText}
                        </div>
                      </div>
                    </foreignObject>
                  );
                })}
              </svg>

              {/* Popover overlay tooltip */}
              {popoverOpen && activeRegion && (() => {
                const showBelow = activeRegion.bboxY < 150;
                const popoverWidth = 240;
                const halfWidth = popoverWidth / 2;
                const clampedX = imageDims.w > popoverWidth 
                  ? Math.max(halfWidth, Math.min(imageDims.w - halfWidth, activeRegion.bboxX + activeRegion.bboxW / 2))
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
                        ? `${((activeRegion.bboxY + activeRegion.bboxH) / imageDims.h) * 100}%`
                        : `${(activeRegion.bboxY / imageDims.h) * 100}%`,
                      transform: showBelow ? 'translate(-50%, 0%)' : 'translate(-50%, -100%)',
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
                            minHeight: '60px',
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
                        <div style={{ wordBreak: 'break-word', lineHeight: '1.4', maxHeight: '120px', overflowY: 'auto' }}>
                          {showTranslations ? (activeRegion.translatedText || 'No translation yet.') : activeRegion.text}
                        </div>
                        
                        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                            {showTranslations ? 'Translated' : 'Original'} ({activeRegion.detectedLanguage})
                          </span>
                          <div style={{ display: 'flex', gap: '10px' }}>
                            <button
                              onClick={() => handleToggleApprove(activeRegion)}
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                color: activeRegion.approved ? 'var(--primary)' : 'var(--text-dim)',
                                padding: '2px',
                                display: 'flex',
                                alignItems: 'center'
                              }}
                              title={activeRegion.approved ? 'Approved' : 'Approve'}
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12"></polyline>
                              </svg>
                            </button>

                            <button
                              onClick={() => {
                                setIsEditingRegion(true);
                                setEditText(showTranslations ? (activeRegion.translatedText || '') : activeRegion.text);
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
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Collapsible Zoom Toolbar */}
          <div className={`floating-zoom-toolbar glass ${isZoomExpanded ? 'expanded' : 'collapsed'}`}>
            <button 
              className="zoom-toggle-handle" 
              onClick={() => setIsZoomExpanded(prev => !prev)}
              title={isZoomExpanded ? 'Hide Zoom Controls' : 'Show Zoom Controls'}
            >
              {isZoomExpanded ? (
                <>
                  <span style={{ writingMode: 'vertical-lr', textTransform: 'uppercase' }}>Zoom</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6"></polyline>
                  </svg>
                </>
              ) : (
                <>
                  <span style={{ writingMode: 'vertical-lr', fontWeight: 'bold' }}>{Math.round(zoom * 100)}%</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6"></polyline>
                  </svg>
                </>
              )}
            </button>
            <div className="zoom-content">
              <button 
                className="btn btn-secondary"
                onClick={() => setZoom(prev => Math.min(3.0, prev + 0.1))}
                disabled={zoom >= 3.0}
                title="Zoom In"
              >
                +
              </button>
              <span className="zoom-value">
                {Math.round(zoom * 100)}%
              </span>
              <button 
                className="btn btn-secondary"
                onClick={() => setZoom(prev => Math.max(0.5, prev - 0.1))}
                disabled={zoom <= 0.5}
                title="Zoom Out"
              >
                -
              </button>
              <button 
                className="btn btn-secondary"
                style={{ fontSize: '11px', padding: '6px 10px', marginTop: '8px' }}
                onClick={() => setZoom(1.0)}
                disabled={zoom === 1.0}
                title="Reset Zoom"
              >
                Reset
              </button>
            </div>
          </div>
        </div>

        {/* Collapsible Translation Sidebar */}
        {showSidebar && (
          <div className="reader-sidebar-nhentai">
            <h2>Workspace Controls</h2>
            
            {!selectedRegion && (
              <div className="panel-section">
                <div className="panel-section-title">Layers Overlay</div>
                
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
                  <span>OCR Bounding Boxes</span>
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
                  <span>Show Translations</span>
                  <label className="switch">
                    <input 
                      type="checkbox" 
                      checked={showTranslations} 
                      onChange={e => setShowTranslations(e.target.checked)} 
                    />
                    <span className="slider"></span>
                  </label>
                </div>
              </div>
            )}

            {selectedRegion && (
              <div className="panel-section" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div className="panel-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Region Inspector</span>
                  <button 
                    onClick={() => setSelectedRegion(null)}
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--border-color)',
                      color: 'var(--text-main)',
                      borderRadius: '6px',
                      padding: '4px 8px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '11px',
                      fontWeight: 600,
                      transition: 'all 0.2s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--bg-hover-more)';
                      e.currentTarget.style.borderColor = 'var(--text-muted)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                      e.currentTarget.style.borderColor = 'var(--border-color)';
                    }}
                    title="Back to Layers Overlay"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="19" y1="12" x2="5" y2="12"></line>
                      <polyline points="12 19 5 12 12 5"></polyline>
                    </svg>
                    Back
                  </button>
                </div>
                
                <div className="ocr-detail-card" style={{ flex: 1, overflowY: 'auto' }}>
                  <div className="badge-row">
                    <span className="meta-badge" style={{ backgroundColor: 'var(--primary-glow)', color: 'var(--primary-hover)', borderColor: 'var(--primary)' }}>
                      Bubble #{selectedRegion.bubbleReadingOrder}
                    </span>
                    <span className="meta-badge" style={{ backgroundColor: 'var(--success-glow)', color: 'var(--success)' }}>
                      {selectedRegion.detectedLanguage}
                    </span>
                    <span className="meta-badge">
                      {(selectedRegion.confidence * 100).toFixed(0)}% Conf
                    </span>
                    {selectedRegion.approved && (
                      <span className="meta-badge" style={{ backgroundColor: 'rgba(16, 185, 129, 0.15)', color: 'var(--success)', borderColor: 'var(--success)' }}>
                        Approved
                      </span>
                    )}
                  </div>
                  
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    Position: x={selectedRegion.bboxX}, y={selectedRegion.bboxY} ({selectedRegion.bboxW}x{selectedRegion.bboxH})
                  </div>

                  <div style={{ marginTop: '8px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase' }}>Detected Text</div>
                    <div className="ocr-text-preview">
                      {selectedRegion.text}
                    </div>
                  </div>

                  {selectedRegion.translatedText && (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase' }}>Translated Text</div>
                      <div className="ocr-text-preview" style={{ color: 'var(--primary-hover)', borderColor: 'var(--primary)' }}>
                        {selectedRegion.translatedText}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="reader-footer-nhentai">
        <div className="reader-page-controls-nhentai">
          <button 
            className="reader-control-btn"
            onClick={() => navigateToPage(1)}
            disabled={curPageNum <= 1}
          >
            &lt;&lt;
          </button>
          <button 
            className="reader-control-btn"
            onClick={() => navigateToPage(curPageNum - 1)}
            disabled={curPageNum <= 1}
          >
            &lt;
          </button>
          
          <span className="reader-page-indicator-nhentai">
            <strong>{curPageNum}</strong> of {totalPages}
          </span>

          <button 
            className="reader-control-btn"
            onClick={() => navigateToPage(curPageNum + 1)}
            disabled={curPageNum >= totalPages}
          >
            &gt;
          </button>
          <button 
            className="reader-control-btn"
            onClick={() => navigateToPage(totalPages)}
            disabled={curPageNum >= totalPages}
          >
            &gt;&gt;
          </button>
        </div>
      </div>
    </div>
  );
};
