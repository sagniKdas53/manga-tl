import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useLocation, matchPath } from 'react-router-dom';

// Types
interface User {
  token: string;
  id: string;
  email: string;
  displayName: string;
  role: string;
}

interface Series {
  id: string;
  title: string;
  originalLanguage: string;
  readingDirection: string;
  coverImageUrl?: string | null;
}

interface Chapter {
  id: string;
  seriesId: string;
  chapterNumber: number;
  title: string;
  coverImageUrl?: string | null;
}

interface Page {
  id: string;
  pageNumber: number;
  imageId: string;
  filename: string;
  url: string;
  chapterId?: string;
}

interface Panel {
  id: string;
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  gridRow: number;
  gridCol: number;
  readingOrder: number;
}

interface OcrRegion {
  id: string;
  text: string;
  translatedText?: string | null;
  approved?: boolean;
  detectedLanguage: string;
  confidence: number;
  rotation: number;
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  panelReadingOrder: number;
  bubbleReadingOrder: number;
}

// Helper to dynamically resolve the context path from the browser address bar
const getContextPath = (): string => {
  const path = window.location.pathname;
  
  // Check known routes to extract context path prefix
  for (const route of ['/login', '/series', '/chapters']) {
    if (path.includes(route)) {
      let cp = path.substring(0, path.indexOf(route));
      if (cp.endsWith('/')) cp = cp.slice(0, -1);
      return cp;
    }
  }
  
  // If not on a sub-route, we must be at the base context path root (e.g. "/tlhub/" or "/my/manga/")
  let cp = path;
  if (cp.endsWith('/')) cp = cp.slice(0, -1);
  return cp;
};

// Override global fetch to prepend the dynamic context path / subfolder base URL to API requests
const originalFetch = window.fetch;
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  let targetUrl = input;
  const context = getContextPath();
  if (typeof targetUrl === 'string' && targetUrl.startsWith('/api')) {
    targetUrl = context + targetUrl;
    console.log(`[Fetch Override] Rewrote API request: ${input} -> ${targetUrl} (detected context: ${context})`);
  }
  return originalFetch(targetUrl, init).then(response => {
    if (response.status === 401 || response.status === 403) {
      if (localStorage.getItem('manga_user')) {
        localStorage.removeItem('manga_user');
        window.location.href = context + '/login';
      }
    }
    return response;
  });
};

// Shadow global fetch inside App.tsx to use window.fetch
const fetch = window.fetch;

// Slug helper function: Strips unicode punctuation & url-unsafe chars, preserves unicode letters
export function toSlug(text: string): string {
  if (!text) return 'manga';
  const cleaned = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-_\.~]/gu, '') // Keep letters, numbers, spaces, hyphens, underscores, tildes, periods
    .trim()
    .replace(/[-\s]+/g, '-'); // replace spaces/hyphens with single hyphen
  return cleaned || 'manga';
}

function AppContent() {
  const navigate = useNavigate();
  const location = useLocation();

  // Match URL params for deep routing
  const seriesMatch = matchPath({ path: "/series/:seriesId/*" }, location.pathname) || matchPath({ path: "/series/:seriesId" }, location.pathname);
  const chapterMatch = matchPath({ path: "/chapters/:chapterId/*" }, location.pathname) || matchPath({ path: "/chapters/:chapterId" }, location.pathname);
  
  const readerMatch = matchPath({ path: "/chapters/:chapterId/:slug/reader/:pageNumber" }, location.pathname)
    || matchPath({ path: "/chapters/:chapterId/reader/:pageNumber" }, location.pathname);

  const seriesId = seriesMatch?.params.seriesId;
  const chapterId = chapterMatch?.params.chapterId;
  const pageNumber = readerMatch?.params.pageNumber;

  // Authentication state
  const [user, setUser] = useState<User | null>(null);
  
  // Domain States
  const [seriesList, setSeriesList] = useState<Series[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<Series | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [selectedPage, setSelectedPage] = useState<Page | null>(null);
  
  // Interactive Reader States
  const [panels, setPanels] = useState<Panel[]>([]);
  const [ocrRegions, setOcrRegions] = useState<OcrRegion[]>([]);
  const [selectedRegion, setSelectedRegion] = useState<OcrRegion | null>(null);
  const [imageDims, setImageDims] = useState({ w: 800, h: 1200 });
  const [showPanels, setShowPanels] = useState(true);
  const [showOcr, setShowOcr] = useState(true);
  const [showTranslations, setShowTranslations] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [loadedImageId, setLoadedImageId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
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
  const hideTimeout = useRef<any>(null);

  // Theme State & Persistence
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('manga_theme');
    return saved === 'light' ? 'light' : 'dark';
  });

  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.remove('light');
    }
    localStorage.setItem('manga_theme', theme);
  }, [theme]);



  // Creation Form States
  const [showSeriesModal, setShowSeriesModal] = useState(false);
  const [editingSeries, setEditingSeries] = useState<Series | null>(null);
  const [newSeriesTitle, setNewSeriesTitle] = useState('');
  const [newSeriesLang, setNewSeriesLang] = useState('ja');
  const [newSeriesDirection, setNewSeriesDirection] = useState('rtl');
  const [newSeriesCoverUrl, setNewSeriesCoverUrl] = useState('');

  const [showChapterModal, setShowChapterModal] = useState(false);
  const [editingChapter, setEditingChapter] = useState<Chapter | null>(null);
  const [newChapterNum, setNewChapterNum] = useState<number>(1);
  const [newChapterTitle, setNewChapterTitle] = useState('');

  // Auth Form State
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [authError, setAuthError] = useState('');

  // Load user session on startup & handle redirects
  useEffect(() => {
    const storedUser = localStorage.getItem('manga_user');
    if (storedUser) {
      try {
        const u = JSON.parse(storedUser);
        setUser(u);
        if (location.pathname === '/login') {
          navigate('/', { replace: true });
        }
      } catch (e) {
        localStorage.removeItem('manga_user');
        navigate('/login', { replace: true });
      }
    } else {
      if (location.pathname !== '/login') {
        navigate('/login', { replace: true });
      }
    }
  }, [location.pathname, navigate]);

  // Fetch Series List (Dashboard)
  useEffect(() => {
    if (user && location.pathname === '/') {
      fetch('/api/series', {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(res => {
        if (!res.ok) throw new Error("Failed to fetch series list");
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data)) {
          setSeriesList(data);
        } else {
          console.error("Expected array for series list, got:", data);
        }
      })
      .catch(err => console.error("Error fetching series:", err));
    }
  }, [user, location.pathname]);

  // Load series details and chapters when seriesId is active in route
  useEffect(() => {
    if (user && seriesId) {
      if (!selectedSeries || selectedSeries.id !== seriesId) {
        setIsLoadingDetails(true);
        fetch(`/api/series/${seriesId}`, {
          headers: { 'Authorization': `Bearer ${user.token}` }
        })
        .then(res => {
          if (!res.ok) throw new Error("Series not found");
          return res.json();
        })
        .then(data => {
          setSelectedSeries(data);
          setIsLoadingDetails(false);
        })
        .catch(err => {
          console.error(err);
          setIsLoadingDetails(false);
        });
      }

      fetch(`/api/series/${seriesId}/chapters`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(res => {
        if (!res.ok) throw new Error("Failed to fetch chapters");
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data)) {
          setChapters(data);
        } else {
          console.error("Expected array for chapters, got:", data);
        }
      })
      .catch(err => console.error("Error fetching chapters:", err));
    }
  }, [seriesId, user]);

  // Load chapter details and pages when chapterId is active in route
  useEffect(() => {
    if (user && chapterId) {
      if (!selectedChapter || selectedChapter.id !== chapterId) {
        setIsLoadingDetails(true);
        fetch(`/api/series/chapters/${chapterId}`, {
          headers: { 'Authorization': `Bearer ${user.token}` }
        })
        .then(res => {
          if (!res.ok) throw new Error("Chapter not found");
          return res.json();
        })
        .then(chapterData => {
          setSelectedChapter(chapterData);
          return fetch(`/api/series/${chapterData.seriesId}`, {
            headers: { 'Authorization': `Bearer ${user.token}` }
          });
        })
        .then(res => {
          if (!res.ok) throw new Error("Series not found");
          return res.json();
        })
        .then(seriesData => {
          setSelectedSeries(seriesData);
          setIsLoadingDetails(false);
        })
        .catch(err => {
          console.error(err);
          setIsLoadingDetails(false);
        });
      }

      fetch(`/api/chapters/${chapterId}/pages`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(res => {
        if (!res.ok) throw new Error("Failed to fetch pages");
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data)) {
          setPages(data);
        } else {
          console.error("Expected array for pages, got:", data);
        }
      })
      .catch(err => console.error("Error fetching pages:", err));
    }
  }, [chapterId, user]);

  // Clear selectedPage and loadedImageId when not in reader view
  useEffect(() => {
    if (!pageNumber) {
      setSelectedPage(null);
      setLoadedImageId(null);
    }
  }, [pageNumber]);

  // Load reader page when pageNumber is active in route
  useEffect(() => {
    if (user && chapterId && pageNumber && pages.length > 0) {
      const firstPage = pages[0];
      if (firstPage.chapterId === chapterId) {
        const targetPage = pages.find(p => p.pageNumber === parseInt(pageNumber));
        if (targetPage) {
          // Fetch image details if selectedPage doesn't match or details for imageId aren't loaded yet
          if (!selectedPage || selectedPage.id !== targetPage.id || loadedImageId !== targetPage.imageId) {
            setIsLoadingDetails(true);
            setSelectedPage(targetPage);
            
            fetch(`/api/images/${targetPage.imageId}`, {
              headers: { 'Authorization': `Bearer ${user.token}` }
            })
            .then(res => {
              if (!res.ok) throw new Error("Image details fetch failed");
              return res.json();
            })
            .then(data => {
              setPanels(data.panels || []);
              setOcrRegions(data.ocrRegions || []);
              setSelectedRegion(null);
              setLoadedImageId(targetPage.imageId);
              setIsLoadingDetails(false);
            })
            .catch(err => {
              console.error("Error loading reader page images:", err);
              setIsLoadingDetails(false);
            });
          }
        }
      }
    }
  }, [chapterId, pageNumber, pages, user, selectedPage, loadedImageId]);

  // Delete page
  const handleDeletePage = async (pageId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // prevent navigation
    if (!window.confirm("Are you sure you want to delete this page? This will also delete all associated panels, OCR regions, and translations.")) return;
    try {
      const res = await fetch(`/api/pages/${pageId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${user?.token}` }
      });
      if (res.ok) {
        // Refresh pages list
        if (selectedChapter) {
          const r = await fetch(`/api/chapters/${selectedChapter.id}/pages`, {
            headers: { 'Authorization': `Bearer ${user?.token}` }
          });
          if (r.ok) {
            const data = await r.json();
            setPages(data);
          }
        }
      } else {
        alert("Failed to delete page");
      }
    } catch (err) {
      console.error("Error deleting page:", err);
    }
  };

  // Reorder page (Move left or right)
  const handleMovePage = async (index: number, direction: 'left' | 'right') => {
    if (!selectedChapter) return;
    const newIndex = direction === 'left' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= pages.length) return;

    // Swap locally for instant feedback
    const updatedPages = [...pages];
    const temp = updatedPages[index];
    updatedPages[index] = updatedPages[newIndex];
    updatedPages[newIndex] = temp;
    
    // Adjust pageNumbers in the updated array
    const finalPages = updatedPages.map((p, idx) => ({ ...p, pageNumber: idx + 1 }));
    setPages(finalPages);

    try {
      const res = await fetch(`/api/chapters/${selectedChapter.id}/pages/reorder`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user?.token}`
        },
        body: JSON.stringify(finalPages.map(p => p.id))
      });
      if (!res.ok) {
        throw new Error("Failed to save reorder on backend");
      }
    } catch (err) {
      console.error("Error saving page order:", err);
      // Revert if error
      fetch(`/api/chapters/${selectedChapter.id}/pages`, {
        headers: { 'Authorization': `Bearer ${user?.token}` }
      })
      .then(r => r.json())
      .then(data => setPages(data))
      .catch(fetchErr => console.error("Error reverting page order:", fetchErr));
    }
  };

  // Process uploaded files sequentially
  const processUploadedFiles = async (files: FileList) => {
    if (!user || !selectedChapter) return;
    
    let nextNum = pages.length + 1;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const formData = new FormData();
      formData.append('chapterId', selectedChapter.id);
      formData.append('pageNumber', nextNum.toString());
      formData.append('file', file);

      try {
        const res = await fetch('/api/images', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${user.token}`
          },
          body: formData
        });
        if (res.ok) {
          nextNum++;
          // Re-fetch pages list
          const r = await fetch(`/api/chapters/${selectedChapter.id}/pages`, {
            headers: { 'Authorization': `Bearer ${user.token}` }
          });
          if (r.ok) {
            const data = await r.json();
            setPages(data);
          }
        }
      } catch (err) {
        console.error("Failed to upload page", err);
      }
    }
  };

  // Drag and Drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      processUploadedFiles(files);
    }
  };

  // Handle Authentication Submission
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
    const payload = isLogin 
      ? { email, password } 
      : { email, password, displayName };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Authentication failed');
      }

      const data = await res.json();
      localStorage.setItem('manga_user', JSON.stringify(data));
      setUser(data);
      navigate('/');
      setEmail('');
      setPassword('');
      setDisplayName('');
    } catch (err: any) {
      setAuthError(err.message || 'Something went wrong');
    }
  };

  // Handle Logout
  const handleLogout = () => {
    localStorage.removeItem('manga_user');
    setUser(null);
    navigate('/login');
  };

  const handleEditSeriesClick = (s: Series, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSeries(s);
    setNewSeriesTitle(s.title);
    setNewSeriesLang(s.originalLanguage);
    setNewSeriesDirection(s.readingDirection);
    setNewSeriesCoverUrl(s.coverImageUrl || '');
    setShowSeriesModal(true);
  };

  const handleNewSeriesClick = () => {
    setEditingSeries(null);
    setNewSeriesTitle('');
    setNewSeriesLang('ja');
    setNewSeriesDirection('rtl');
    setNewSeriesCoverUrl('');
    setShowSeriesModal(true);
  };

  const handleCancelSeriesModal = () => {
    setShowSeriesModal(false);
    setEditingSeries(null);
    setNewSeriesTitle('');
    setNewSeriesCoverUrl('');
  };

  // Create or Update Series
  const handleCreateSeries = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    try {
      const isEdit = !!editingSeries;
      const url = isEdit ? `/api/series/${editingSeries.id}` : '/api/series';
      const method = isEdit ? 'PUT' : 'POST';
      
      const res = await fetch(url, {
        method: method,
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}`
        },
        body: JSON.stringify({
          title: newSeriesTitle,
          originalLanguage: newSeriesLang,
          readingDirection: newSeriesDirection,
          coverImageUrl: newSeriesCoverUrl || null
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (isEdit) {
          setSeriesList(prev => prev.map(s => s.id === data.id ? data : s));
          if (selectedSeries && selectedSeries.id === data.id) {
            setSelectedSeries(data);
          }
        } else {
          setSeriesList([...seriesList, data]);
        }
        setShowSeriesModal(false);
        setEditingSeries(null);
        setNewSeriesTitle('');
        setNewSeriesCoverUrl('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteSeries = async (seriesId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm("Are you sure you want to delete this series? This will delete all chapters and pages!")) return;
    try {
      const res = await fetch(`/api/series/${seriesId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${user?.token}` }
      });
      if (res.ok) {
        setSeriesList(prev => prev.filter(s => s.id !== seriesId));
        if (selectedSeries && selectedSeries.id === seriesId) {
          setSelectedSeries(null);
          navigate('/');
        }
      } else {
        alert("Failed to delete series");
      }
    } catch (err) {
      console.error("Error deleting series:", err);
    }
  };

  const handleEditChapterClick = (c: Chapter, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingChapter(c);
    setNewChapterNum(c.chapterNumber);
    setNewChapterTitle(c.title || '');
    setShowChapterModal(true);
  };

  const handleNewChapterClick = () => {
    setEditingChapter(null);
    const maxNum = chapters.reduce((max, c) => c.chapterNumber > max ? c.chapterNumber : max, 0);
    setNewChapterNum(maxNum + 1);
    setNewChapterTitle('');
    setShowChapterModal(true);
  };

  const handleCancelChapterModal = () => {
    setShowChapterModal(false);
    setEditingChapter(null);
    setNewChapterTitle('');
  };

  // Create or Update Chapter
  const handleCreateChapter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !selectedSeries) return;
    try {
      const isEdit = !!editingChapter;
      const url = isEdit ? `/api/series/chapters/${editingChapter.id}` : `/api/series/${selectedSeries.id}/chapters`;
      const method = isEdit ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method: method,
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}`
        },
        body: JSON.stringify({
          chapterNumber: newChapterNum,
          title: newChapterTitle
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (isEdit) {
          setChapters(prev => prev.map(c => c.id === data.id ? { ...c, chapterNumber: data.chapterNumber, title: data.title } : c));
          if (selectedChapter && selectedChapter.id === data.id) {
            setSelectedChapter({ ...selectedChapter, chapterNumber: data.chapterNumber, title: data.title });
          }
        } else {
          setChapters([...chapters, data]);
          setNewChapterNum(newChapterNum + 1);
        }
        setShowChapterModal(false);
        setEditingChapter(null);
        setNewChapterTitle('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteChapter = async (chapterId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm("Are you sure you want to delete this chapter? This will delete all pages!")) return;
    try {
      const res = await fetch(`/api/series/chapters/${chapterId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${user?.token}` }
      });
      if (res.ok) {
        setChapters(prev => prev.filter(c => c.id !== chapterId));
        if (selectedChapter && selectedChapter.id === chapterId) {
          setSelectedChapter(null);
          if (selectedSeries) {
            navigate(`/series/${selectedSeries.id}/${toSlug(selectedSeries.title)}`);
          } else {
            navigate('/');
          }
        }
      } else {
        alert("Failed to delete chapter");
      }
    } catch (err) {
      console.error("Error deleting chapter:", err);
    }
  };

  // Handle File Upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) processUploadedFiles(files);
  };

  const handleImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setImageDims({
      w: e.currentTarget.naturalWidth,
      h: e.currentTarget.naturalHeight
    });
  };

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

  // --- HOVER / INTERACTIVE POPOVER CONTROLS ---
  const handleMouseEnterRegion = (r: OcrRegion) => {
    if (hideTimeout.current) clearTimeout(hideTimeout.current);
    setActiveRegion(r);
    setPopoverOpen(true);
    setEditText(showTranslations ? (r.translatedText || '') : r.text);
  };

  const handleMouseLeaveRegion = () => {
    hideTimeout.current = setTimeout(() => {
      setPopoverOpen(false);
      setIsEditingRegion(false);
    }, 300);
  };

  const handleMouseEnterPopover = () => {
    if (hideTimeout.current) clearTimeout(hideTimeout.current);
  };

  const handleMouseLeavePopover = () => {
    setPopoverOpen(false);
    setIsEditingRegion(false);
  };

  const handleToggleApprove = async (r: OcrRegion) => {
    const updatedApproved = !(r.approved);
    
    setOcrRegions(prev => prev.map(item => item.id === r.id ? { ...item, approved: updatedApproved } : item));
    if (activeRegion && activeRegion.id === r.id) {
      setActiveRegion(prev => prev ? { ...prev, approved: updatedApproved } : null);
    }

    try {
      const res = await fetch(`/api/ocr-regions/${r.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user?.token}`
        },
        body: JSON.stringify({ approved: updatedApproved })
      });
      if (!res.ok) {
        throw new Error("Failed to update approval on server");
      }
    } catch (err) {
      console.error("Error updating approval status:", err);
      setOcrRegions(prev => prev.map(item => item.id === r.id ? { ...item, approved: !updatedApproved } : item));
      if (activeRegion && activeRegion.id === r.id) {
        setActiveRegion(prev => prev ? { ...prev, approved: !updatedApproved } : null);
      }
    }
  };

  const handleSaveEdit = async () => {
    if (!activeRegion) return;
    const body: any = {};
    if (showTranslations) {
      body.translatedText = editText;
    } else {
      body.text = editText;
    }

    setOcrRegions(prev => prev.map(item => item.id === activeRegion.id ? { ...item, ...(showTranslations ? { translatedText: editText } : { text: editText }) } : item));
    setActiveRegion(prev => prev ? { ...prev, ...(showTranslations ? { translatedText: editText } : { text: editText }) } : null);
    setIsEditingRegion(false);

    try {
      const res = await fetch(`/api/ocr-regions/${activeRegion.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user?.token}`
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        throw new Error("Failed to save edit on server");
      }
    } catch (err) {
      console.error("Error saving region text edit:", err);
    }
  };

  const handleRedoRegion = async (r: OcrRegion, forceType?: 'ocr' | 'translation') => {
    setIsRedoing(true);
    const type = forceType || (showTranslations ? 'translation' : 'ocr');

    try {
      const res = await fetch(`/api/ocr-regions/${r.id}/redo?type=${type}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user?.token}`
        }
      });
      
      if (!res.ok) {
        throw new Error("Redo request failed");
      }

      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        if (attempts > 20) {
          clearInterval(interval);
          setIsRedoing(false);
          alert("Redo timed out. Please try again.");
          return;
        }

        try {
          const checkRes = await fetch(`/api/images/${selectedPage?.imageId}`, {
            headers: { 'Authorization': `Bearer ${user?.token}` }
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
          console.error("Polling error during redo:", pollErr);
        }
      }, 500);

    } catch (err) {
      console.error("Error redoing region:", err);
      setIsRedoing(false);
      alert("Failed to start redo job.");
    }
  };
  const navigateToPage = (num: number) => {
    if (num >= 1 && num <= pages.length) {
      const slugPart = selectedChapter ? `${toSlug(selectedChapter.title || `chapter-${selectedChapter.chapterNumber}`)}/` : '';
      navigate(`/chapters/${chapterId}/${slugPart}reader/${num}`);
    }
  };

  useEffect(() => {
    if (!readerMatch || pages.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' || 
        target.tagName === 'TEXTAREA' || 
        target.isContentEditable
      ) {
        return;
      }

      const curPageNum = parseInt(pageNumber || '1');
      
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
  }, [readerMatch, pageNumber, pages.length, selectedChapter, chapterId, navigate]);

  // SUB-RENDER VIEWS
  const renderAuth = () => (
    <div className="auth-page">
      <div className="auth-card glass">
        <div className="auth-header">
          <h2>{isLogin ? 'Welcome Back' : 'Create Account'}</h2>
          <p>{isLogin ? 'Access your translation workspace' : 'Get started by creating a local user'}</p>
        </div>
        <form onSubmit={handleAuthSubmit}>
          {!isLogin && (
            <div className="form-group">
              <label className="form-label">Display Name</label>
              <input 
                type="text" 
                className="form-input" 
                value={displayName} 
                onChange={e => setDisplayName(e.target.value)} 
                placeholder="John Doe" 
                required 
              />
            </div>
          )}
          <div className="form-group">
            <label className="form-label">Email Address</label>
            <input 
              type="email" 
              className="form-input" 
              value={email} 
              onChange={e => setEmail(e.target.value)} 
              placeholder="admin@manga.local" 
              required 
            />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input 
              type="password" 
              className="form-input" 
              value={password} 
              onChange={e => setPassword(e.target.value)} 
              placeholder="••••••••" 
              required 
            />
          </div>

          {authError && <div style={{ color: 'var(--error)', fontSize: '13px', marginBottom: '16px' }}>{authError}</div>}

          <button type="submit" className="btn btn-primary" style={{ width: '100%', marginBottom: '16px' }}>
            {isLogin ? 'Sign In' : 'Sign Up'}
          </button>
          
          <button type="button" className="btn btn-text" onClick={() => setIsLogin(!isLogin)} style={{ width: '100%' }}>
            {isLogin ? "Don't have an account? Sign Up" : "Already have an account? Sign In"}
          </button>
        </form>
      </div>
    </div>
  );

  const renderDashboard = () => (
    <div className="dashboard-content">
      <div className="page-header">
        <div>
          <h1>My Manga Library</h1>
          <p style={{ color: 'var(--text-muted)', margin: '8px 0 0' }}>Manage translation projects and OCR workflows</p>
        </div>
        <button className="btn btn-primary" onClick={handleNewSeriesClick}>
          + New Series
        </button>
      </div>

      <div className="grid-cols-3">
        {seriesList.map(s => (
          <div 
            key={s.id} 
            className="manga-card glass" 
            onClick={() => {
              setSelectedSeries(s);
              navigate(`/series/${s.id}/${toSlug(s.title)}`);
            }}
          >
            <div className="manga-cover-container">
              {s.coverImageUrl ? (
                <img src={s.coverImageUrl} className="manga-cover-img" alt={s.title} />
              ) : (
                <div className="manga-cover-placeholder">{s.title}</div>
              )}
              <div className="manga-card-actions" onClick={e => e.stopPropagation()}>
                <button className="action-btn-small" onClick={(e) => handleEditSeriesClick(s, e)} title="Edit Series">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                  </svg>
                </button>
                <button className="action-btn-small delete-btn" onClick={(e) => handleDeleteSeries(s.id, e)} title="Delete Series">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </button>
              </div>
            </div>
            <div className="manga-card-content">
              <h3>{s.title}</h3>
              <div className="manga-meta">
                <span className="meta-badge">{s.originalLanguage}</span>
                <span className="meta-badge">{s.readingDirection}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {showSeriesModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass" style={{ padding: '32px', width: '100%', maxWidth: '440px' }}>
            <h2 style={{ fontFamily: 'var(--font-display)', marginBottom: '24px' }}>
              {editingSeries ? 'Edit Series' : 'Create New Series'}
            </h2>
            <form onSubmit={handleCreateSeries}>
              <div className="form-group">
                <label className="form-label">Series Title</label>
                <input 
                  type="text" 
                  className="form-input" 
                  value={newSeriesTitle} 
                  onChange={e => setNewSeriesTitle(e.target.value)} 
                  placeholder="e.g. My Hero Academia" 
                  required 
                />
              </div>
              <div className="form-group">
                <label className="form-label">Cover Image URL (Optional)</label>
                <input 
                  type="text" 
                  className="form-input" 
                  value={newSeriesCoverUrl} 
                  onChange={e => setNewSeriesCoverUrl(e.target.value)} 
                  placeholder="Leave empty for default cover" 
                />
              </div>
              <div className="form-group">
                <label className="form-label">Original Language</label>
                <select className="form-input" value={newSeriesLang} onChange={e => setNewSeriesLang(e.target.value)}>
                  <option value="ja">Japanese (ja)</option>
                  <option value="zh-TW">Traditional Chinese (zh-TW)</option>
                  <option value="zh-CN">Simplified Chinese (zh-CN)</option>
                  <option value="ko">Korean (ko)</option>
                  <option value="en">English (en)</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Reading Direction</label>
                <select className="form-input" value={newSeriesDirection} onChange={e => setNewSeriesDirection(e.target.value)}>
                  <option value="rtl">Right to Left (Manga)</option>
                  <option value="ltr">Left to Right (Comics)</option>
                  <option value="ttb">Top to Bottom (Webtoons)</option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: '12px', marginTop: '24px' }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={handleCancelSeriesModal}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>
                  {editingSeries ? 'Save' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );

  const renderSeries = () => {
    if (isLoadingDetails || !selectedSeries) {
      return (
        <div className="dashboard-content text-center">
          <div className="spinner"></div>
          <p>Loading series details...</p>
        </div>
      );
    }
    return (
      <div className="dashboard-content nhentai-style">
        <div className="mb-8">
          <button className="btn btn-secondary" onClick={() => navigate('/')} style={{ padding: '8px 16px', marginBottom: '16px' }}>
            &larr; Back to Library
          </button>
        </div>

        {/* nHentai Split Columns Layout */}
        <div className="series-details-container">
          {/* Left Column: Cover */}
          <div className="series-cover-column">
            {selectedSeries.coverImageUrl ? (
              <img src={selectedSeries.coverImageUrl} className="series-large-cover" alt={selectedSeries.title} />
            ) : (
              <div className="series-large-cover-placeholder">
                <span>{selectedSeries.title}</span>
              </div>
            )}
          </div>

          {/* Right Column: Info */}
          <div className="series-info-column">
            <h1 className="series-title">{selectedSeries.title}</h1>
            
            {/* Metadata Table in nHentai style */}
            <div className="nhentai-meta-table">
              <div className="meta-row">
                <span className="meta-label">Language:</span>
                <span className="meta-value">
                  <span className="meta-badge-nhentai">{selectedSeries.originalLanguage}</span>
                </span>
              </div>
              <div className="meta-row">
                <span className="meta-label">Direction:</span>
                <span className="meta-value">
                  <span className="meta-badge-nhentai">{selectedSeries.readingDirection}</span>
                </span>
              </div>
              <div className="meta-row">
                <span className="meta-label">Chapters:</span>
                <span className="meta-value">{chapters.length}</span>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="series-actions-row">
              <button className="btn-nhentai btn-nhentai-primary" onClick={handleNewChapterClick}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                Add Chapter
              </button>
              <button className="btn-nhentai btn-nhentai-secondary" onClick={(e) => handleEditSeriesClick(selectedSeries, e)}>
                Edit Series
              </button>
              <button className="btn-nhentai btn-nhentai-danger" onClick={(e) => handleDeleteSeries(selectedSeries.id, e)}>
                Delete Series
              </button>
            </div>
          </div>
        </div>

        {/* Chapters Section Header */}
        <div className="chapters-section-header">
          <h2>Chapters ({chapters.length})</h2>
        </div>

        {/* Chapters Grid */}
        <div className="chapters-grid">
          {chapters.map(c => (
            <div 
              key={c.id} 
              className="chapter-card-nhentai" 
              onClick={() => {
                setSelectedChapter(c);
                navigate(`/chapters/${c.id}/${toSlug(c.title || `chapter-${c.chapterNumber}`)}`);
              }}
            >
              <div className="chapter-cover-container-nhentai">
                {c.coverImageUrl ? (
                  <img src={c.coverImageUrl} className="chapter-cover-img-nhentai" alt={c.title || `Chapter ${c.chapterNumber}`} />
                ) : selectedSeries.coverImageUrl ? (
                  <img src={selectedSeries.coverImageUrl} className="chapter-cover-img-nhentai fallback" alt="Fallback Cover" />
                ) : (
                  <div className="chapter-cover-placeholder-nhentai">
                    <span>C{c.chapterNumber}</span>
                  </div>
                )}
                
                {/* Chapter actions overlay */}
                <div className="chapter-actions-overlay" onClick={e => e.stopPropagation()}>
                  <button className="action-btn-small" onClick={(e) => handleEditChapterClick(c, e)} title="Edit Chapter">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                      <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                    </svg>
                  </button>
                  <button className="action-btn-small delete-btn" onClick={(e) => handleDeleteChapter(c.id, e)} title="Delete Chapter">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                  </button>
                </div>
              </div>
              
              <div className="chapter-card-info-nhentai">
                <div className="chapter-card-number-nhentai">Chapter {c.chapterNumber}</div>
                <div className="chapter-card-title-nhentai" title={c.title || 'Untitled'}>
                  {c.title || 'Untitled'}
                </div>
              </div>
            </div>
          ))}
        </div>

        {showChapterModal && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="glass" style={{ padding: '32px', width: '100%', maxWidth: '400px' }}>
              <h2 style={{ fontFamily: 'var(--font-display)', marginBottom: '24px' }}>
                {editingChapter ? 'Edit Chapter' : 'Add Chapter'}
              </h2>
              <form onSubmit={handleCreateChapter}>
                <div className="form-group">
                  <label className="form-label">Chapter Number</label>
                  <input 
                    type="number" 
                    className="form-input" 
                    value={newChapterNum} 
                    onChange={e => setNewChapterNum(parseInt(e.target.value))} 
                    required 
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Chapter Title</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    value={newChapterTitle} 
                    onChange={e => setNewChapterTitle(e.target.value)} 
                    placeholder="e.g. The Beginning" 
                  />
                </div>
                <div style={{ display: 'flex', gap: '12px', marginTop: '24px' }}>
                  <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={handleCancelChapterModal}>Cancel</button>
                  <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>
                    {editingChapter ? 'Save' : 'Add'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderChapter = () => {
    if (isLoadingDetails || !selectedSeries || !selectedChapter) {
      return (
        <div className="dashboard-content text-center">
          <div className="spinner"></div>
          <p>Loading chapter details...</p>
        </div>
      );
    }
    return (
      <div className="dashboard-content">
        <div className="mb-8">
          <button className="btn btn-secondary" onClick={() => navigate(`/series/${selectedSeries.id}/${toSlug(selectedSeries.title)}`)} style={{ padding: '8px 16px', marginBottom: '16px' }}>
            &larr; Back to Series
          </button>
          <div className="page-header">
            <div>
              <h1>Chapter {selectedChapter.chapterNumber}</h1>
              <p style={{ color: 'var(--text-muted)', margin: '8px 0 0' }}>{selectedSeries.title} / {selectedChapter.title || 'Untitled'}</p>
            </div>
            <button className="btn btn-secondary" onClick={() => {
              fetch(`/api/chapters/${selectedChapter.id}/pages`, {
                headers: { 'Authorization': `Bearer ${user?.token}` }
              })
              .then(r => r.json())
              .then(data => setPages(data));
            }}>
              Refresh Gallery
            </button>
          </div>
        </div>

        <div 
          className={`upload-dropzone ${isDragging ? 'dragging' : ''}`} 
          onClick={() => document.getElementById('file-upload')?.click()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <svg className="upload-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          <h3 style={{ margin: '0 0 8px' }}>Upload Manga Pages</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Drag and drop multiple images, or click to browse</p>
          <input 
            id="file-upload" 
            type="file" 
            multiple 
            accept="image/*" 
            style={{ display: 'none' }} 
            onChange={handleFileUpload} 
          />
        </div>

        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '22px' }}>Uploaded Pages ({pages.length})</h2>
        <div className="pages-grid">
          {pages.map((p, idx) => (
            <div 
              key={p.id} 
              className="page-thumbnail-container glass" 
              onClick={() => {
                setSelectedPage(p);
                navigate(`/chapters/${selectedChapter.id}/${toSlug(selectedChapter.title || `chapter-${selectedChapter.chapterNumber}`)}/reader/${p.pageNumber}`);
              }}
              style={{ position: 'relative' }}
            >
              <img src={p.url} className="page-thumbnail" alt={`Page ${p.pageNumber}`} />
              <span className="page-num-tag">Page {p.pageNumber}</span>

              {/* Delete button (top right overlay) */}
              <button 
                className="delete-page-btn" 
                onClick={(e) => handleDeletePage(p.id, e)}
                title="Delete page"
              >
                &times;
              </button>

              {/* Reorder controls overlay */}
              <div className="reorder-controls" onClick={e => e.stopPropagation()}>
                <button 
                  className="reorder-btn"
                  onClick={() => handleMovePage(idx, 'left')}
                  disabled={idx === 0}
                  title="Move page left"
                >
                  &larr;
                </button>
                <button 
                  className="reorder-btn"
                  onClick={() => handleMovePage(idx, 'right')}
                  disabled={idx === pages.length - 1}
                  title="Move page right"
                >
                  &rarr;
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderReader = () => {
    if (isLoadingDetails || !selectedPage) {
      return (
        <div className="reader-container-nhentai" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div className="spinner"></div>
          <p>Loading page details...</p>
        </div>
      );
    }

    const curPageNum = parseInt(pageNumber || '1');
    const totalPages = pages.length;

    return (
      <div className="reader-container-nhentai">
        {/* nHentai-style Top Navigation Bar */}
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

          {/* Page Selector Controls */}
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

          {/* Toggle Sidebar Gear Button */}
          <button 
            className={`reader-nav-btn gear-btn ${showSidebar ? 'active' : ''}`}
            onClick={() => setShowSidebar(!showSidebar)}
            title="Toggle Workspace Sidebar"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
        </div>

        {/* Reader Workspace Split Frame */}
        <div className="reader-workspace-frame-nhentai">
          <div className="reader-main-nhentai">
            {isLoadingDetails ? (
              <div style={{ textAlign: 'center', margin: 'auto' }}>
                <div className="spinner"></div>
                <p>Loading panels and OCR analysis...</p>
              </div>
            ) : (
              <>
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
                                  {/* Tick (Approve) Button */}
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
                                    title={activeRegion.approved ? "Approved" : "Approve"}
                                  >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                      <polyline points="20 6 9 17 4 12"></polyline>
                                    </svg>
                                  </button>

                                  {/* Pencil (Edit) Button */}
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

                                  {/* Re-run OCR Button */}
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

                                  {/* Re-translate Button */}
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
                    onClick={() => setIsZoomExpanded(!isZoomExpanded)}
                    title={isZoomExpanded ? "Hide Zoom Controls" : "Show Zoom Controls"}
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
              </>
            )}
          </div>

          {/* nHentai-style Collapsible Translation Workspace Sidebar */}
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

        {/* nHentai-style Bottom Navigation Bar */}
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

  return (
    <div className="app-container">
      {/* Navigation Bar */}
      {!readerMatch && (
        <nav className="nav-bar">
          <div className="logo" onClick={() => user && navigate('/')} style={{ cursor: user ? 'pointer' : 'default' }}>
            <div className="logo-icon">M</div>
            Manga Translation Hub
          </div>
          <div className="nav-actions">
            {/* Theme Toggle Button */}
            <button 
              className="theme-toggle-btn"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}
            >
              {theme === 'dark' ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5"></circle>
                  <line x1="12" y1="1" x2="12" y2="3"></line>
                  <line x1="12" y1="21" x2="12" y2="23"></line>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                  <line x1="1" y1="12" x2="3" y2="12"></line>
                  <line x1="21" y1="12" x2="23" y2="12"></line>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
                </svg>
              )}
            </button>
            
            {user && (
              <>
                <div className="user-badge">
                  <span className="user-dot"></span>
                  {user.displayName}
                </div>
                <button className="btn btn-secondary" onClick={handleLogout} style={{ padding: '6px 12px' }}>
                  Sign Out
                </button>
              </>
            )}
          </div>
        </nav>
      )}

      <Routes>
        <Route path="/login" element={renderAuth()} />
        <Route path="/" element={renderDashboard()} />
        <Route path="/series/:seriesId" element={renderSeries()} />
        <Route path="/series/:seriesId/:slug" element={renderSeries()} />
        <Route path="/chapters/:chapterId" element={renderChapter()} />
        <Route path="/chapters/:chapterId/:slug" element={renderChapter()} />
        <Route path="/chapters/:chapterId/reader/:pageNumber" element={renderReader()} />
        <Route path="/chapters/:chapterId/:slug/reader/:pageNumber" element={renderReader()} />
      </Routes>
    </div>
  );
}

function App() {
  const cleanBaseName = getContextPath() || '/';

  return (
    <BrowserRouter basename={cleanBaseName}>
      <AppContent />
    </BrowserRouter>
  );
}

export default App;
