import React, { useState, useEffect } from 'react';
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
}

interface Chapter {
  id: string;
  seriesId: string;
  chapterNumber: number;
  title: string;
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
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [loadedImageId, setLoadedImageId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isToolbarExpanded, setIsToolbarExpanded] = useState(true);
  const [zoom, setZoom] = useState(1.0);
  const [isZoomExpanded, setIsZoomExpanded] = useState(true);



  // Creation Form States
  const [showSeriesModal, setShowSeriesModal] = useState(false);
  const [newSeriesTitle, setNewSeriesTitle] = useState('');
  const [newSeriesLang, setNewSeriesLang] = useState('ja');
  const [newSeriesDirection, setNewSeriesDirection] = useState('rtl');

  const [showChapterModal, setShowChapterModal] = useState(false);
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
      .then(res => res.json())
      .then(data => setSeriesList(data))
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
      .then(res => res.json())
      .then(data => setChapters(data))
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
      .then(res => res.json())
      .then(data => setPages(data))
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

  // Create Series
  const handleCreateSeries = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    try {
      const res = await fetch('/api/series', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}`
        },
        body: JSON.stringify({
          title: newSeriesTitle,
          originalLanguage: newSeriesLang,
          readingDirection: newSeriesDirection
        })
      });
      if (res.ok) {
        const data = await res.json();
        setSeriesList([...seriesList, data]);
        setShowSeriesModal(false);
        setNewSeriesTitle('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Create Chapter
  const handleCreateChapter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !selectedSeries) return;
    try {
      const res = await fetch(`/api/series/${selectedSeries.id}/chapters`, {
        method: 'POST',
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
        setChapters([...chapters, data]);
        setShowChapterModal(false);
        setNewChapterTitle('');
        setNewChapterNum(newChapterNum + 1);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Handle File Upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) processUploadedFiles(files);
  };

  // Set image natural dimensions for SVG scaling
  const handleImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setImageDims({
      w: e.currentTarget.naturalWidth,
      h: e.currentTarget.naturalHeight
    });
  };

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
        <button className="btn btn-primary" onClick={() => setShowSeriesModal(true)}>
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
            <h3>{s.title}</h3>
            <div className="manga-meta">
              <span className="meta-badge">{s.originalLanguage}</span>
              <span className="meta-badge">{s.readingDirection}</span>
            </div>
          </div>
        ))}
      </div>

      {showSeriesModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass" style={{ padding: '32px', width: '100%', maxWidth: '440px' }}>
            <h2 style={{ fontFamily: 'var(--font-display)', marginBottom: '24px' }}>Create New Series</h2>
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
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowSeriesModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>Create</button>
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
      <div className="dashboard-content">
        <div className="mb-8">
          <button className="btn btn-secondary" onClick={() => navigate('/')} style={{ padding: '8px 16px', marginBottom: '16px' }}>
            &larr; Back to Library
          </button>
          <div className="page-header">
            <div>
              <h1>{selectedSeries.title}</h1>
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                <span className="meta-badge">{selectedSeries.originalLanguage}</span>
                <span className="meta-badge">{selectedSeries.readingDirection}</span>
              </div>
            </div>
            <button className="btn btn-primary" onClick={() => setShowChapterModal(true)}>
              + Add Chapter
            </button>
          </div>
        </div>

        <div className="chapter-list">
          {chapters.map(c => (
            <div 
              key={c.id} 
              className="chapter-row glass" 
              onClick={() => {
                setSelectedChapter(c);
                navigate(`/chapters/${c.id}/${toSlug(c.title || `chapter-${c.chapterNumber}`)}`);
              }}
              style={{ cursor: 'pointer' }}
            >
              <div className="chapter-title">Chapter {c.chapterNumber}: {c.title || 'Untitled'}</div>
              <button className="btn btn-text">Open Workspace &rarr;</button>
            </div>
          ))}
        </div>

        {showChapterModal && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="glass" style={{ padding: '32px', width: '100%', maxWidth: '400px' }}>
              <h2 style={{ fontFamily: 'var(--font-display)', marginBottom: '24px' }}>Add Chapter</h2>
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
                  <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowChapterModal(false)}>Cancel</button>
                  <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>Add</button>
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
        <div className="reader-container" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div className="spinner"></div>
          <p>Loading page details...</p>
        </div>
      );
    }
    return (
      <div className="reader-container">
        <div className="reader-main">
          {isLoadingDetails ? (
            <div style={{ textAlign: 'center' }}>
              <div className="spinner"></div>
              <p>Loading panels and OCR analysis...</p>
            </div>
          ) : (
            <>
              <div className="reader-canvas-area">
                <div className="manga-canvas-wrapper">
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
                      return (
                        <g key={r.id} onClick={() => setSelectedRegion(r)}>
                          <rect 
                            x={r.bboxX}
                            y={r.bboxY}
                            width={r.bboxW}
                            height={r.bboxH}
                            className="svg-ocr-box"
                            style={{ 
                              fill: isSelected ? 'rgba(139, 92, 246, 0.25)' : 'rgba(16, 185, 129, 0.12)',
                              stroke: isSelected ? 'var(--primary)' : 'var(--success)'
                            }}
                          />
                          <g transform={`translate(${r.bboxX + 10}, ${r.bboxY + 10})`}>
                            <circle cx="0" cy="0" r="8" fill={isSelected ? 'var(--primary)' : 'var(--success)'} />
                            <text cx="0" cy="0" className="bubble-text-tag">{r.bubbleReadingOrder}</text>
                          </g>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>

              {/* Collapsible Reader Toolbar */}
              <div className={`floating-reader-toolbar glass ${isToolbarExpanded ? 'expanded' : 'collapsed'}`}>
                <button 
                  className="toolbar-toggle-handle" 
                  onClick={() => setIsToolbarExpanded(!isToolbarExpanded)}
                  title={isToolbarExpanded ? "Hide Controls" : "Show Controls"}
                >
                  {isToolbarExpanded ? (
                    <>
                      <span>Hide</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9"></polyline>
                      </svg>
                    </>
                  ) : (
                    <>
                      <span>Page {pageNumber} of {pages.length}</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="18 15 12 9 6 15"></polyline>
                      </svg>
                    </>
                  )}
                </button>
                <div className="toolbar-content">
                  <button 
                    className="btn btn-secondary" 
                    onClick={() => {
                      const prevNum = parseInt(pageNumber || '1') - 1;
                      navigate(`/chapters/${selectedChapter?.id}/${toSlug(selectedChapter?.title || `chapter-${selectedChapter?.chapterNumber}`)}/reader/${prevNum}`);
                    }}
                    disabled={parseInt(pageNumber || '1') <= 1}
                  >
                    &larr; Prev Page
                  </button>
                  <span className="page-indicator">
                    Page {pageNumber} of {pages.length}
                  </span>
                  <button 
                    className="btn btn-secondary" 
                    onClick={() => {
                      const nextNum = parseInt(pageNumber || '1') + 1;
                      navigate(`/chapters/${selectedChapter?.id}/${toSlug(selectedChapter?.title || `chapter-${selectedChapter?.chapterNumber}`)}/reader/${nextNum}`);
                    }}
                    disabled={parseInt(pageNumber || '1') >= pages.length}
                  >
                    Next Page &rarr;
                  </button>
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

        <div className="reader-sidebar">
          <button className="btn btn-secondary" onClick={() => navigate(`/chapters/${selectedChapter ? selectedChapter.id : ''}/${selectedChapter ? toSlug(selectedChapter.title || `chapter-${selectedChapter.chapterNumber}`) : ''}`)} style={{ marginBottom: '24px' }}>
            &larr; Back to Chapter
          </button>

          <h2>Workspace Controls</h2>
          
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
          </div>

          <div className="panel-section" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="panel-section-title">Region Inspector</div>
            
            {selectedRegion ? (
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
              </div>
            ) : (
              <div style={{ color: 'var(--text-dim)', textAlign: 'center', margin: 'auto 0', fontSize: '14px' }}>
                Click on any green OCR region box in the reader to inspect properties.
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="app-container">
      {/* Navigation Bar */}
      <nav className="nav-bar">
        <div className="logo" onClick={() => user && navigate('/')} style={{ cursor: user ? 'pointer' : 'default' }}>
          <div className="logo-icon">M</div>
          Manga Translation Hub
        </div>
        {user && (
          <div className="nav-actions">
            <div className="user-badge">
              <span className="user-dot"></span>
              {user.displayName}
            </div>
            <button className="btn btn-secondary" onClick={handleLogout} style={{ padding: '6px 12px' }}>
              Sign Out
            </button>
          </div>
        )}
      </nav>

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
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}

export default App;
