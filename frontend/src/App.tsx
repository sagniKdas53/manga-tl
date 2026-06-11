import React, { useState, useEffect } from 'react';

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

function App() {
  // Navigation & Authentication
  const [user, setUser] = useState<User | null>(null);
  const [view, setView] = useState<'auth' | 'dashboard' | 'series' | 'chapter' | 'reader'>('auth');
  
  // Auth Form State
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [authError, setAuthError] = useState('');

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

  // Creation Form States
  const [showSeriesModal, setShowSeriesModal] = useState(false);
  const [newSeriesTitle, setNewSeriesTitle] = useState('');
  const [newSeriesLang, setNewSeriesLang] = useState('ja');
  const [newSeriesDirection, setNewSeriesDirection] = useState('rtl');

  const [showChapterModal, setShowChapterModal] = useState(false);
  const [newChapterNum, setNewChapterNum] = useState<number>(1);
  const [newChapterTitle, setNewChapterTitle] = useState('');

  // Load user session on startup
  useEffect(() => {
    const storedUser = localStorage.getItem('manga_user');
    if (storedUser) {
      try {
        const u = JSON.parse(storedUser);
        setUser(u);
        setView('dashboard');
      } catch (e) {
        localStorage.removeItem('manga_user');
      }
    }
  }, []);

  // Fetch Series List
  useEffect(() => {
    if (user && view === 'dashboard') {
      fetch('/api/series', {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(res => res.json())
      .then(data => setSeriesList(data))
      .catch(err => console.error("Error fetching series:", err));
    }
  }, [user, view]);

  // Fetch Chapters
  useEffect(() => {
    if (user && selectedSeries && view === 'series') {
      fetch(`/api/series/${selectedSeries.id}/chapters`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(res => res.json())
      .then(data => setChapters(data))
      .catch(err => console.error("Error fetching chapters:", err));
    }
  }, [user, selectedSeries, view]);

  // Fetch Pages in Chapter
  useEffect(() => {
    if (user && selectedChapter && view === 'chapter') {
      fetch(`/api/chapters/${selectedChapter.id}/pages`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(res => res.json())
      .then(data => setPages(data))
      .catch(err => console.error("Error fetching pages:", err));
    }
  }, [user, selectedChapter, view]);

  // Fetch Page Details (Panels & OCR)
  useEffect(() => {
    if (user && selectedPage && view === 'reader') {
      setIsLoadingDetails(true);
      fetch(`/api/images/${selectedPage.imageId}`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(res => res.json())
      .then(data => {
        setPanels(data.panels || []);
        setOcrRegions(data.ocrRegions || []);
        setSelectedRegion(null);
        setIsLoadingDetails(false);
      })
      .catch(err => {
        console.error("Error fetching page details:", err);
        setIsLoadingDetails(false);
      });
    }
  }, [user, selectedPage, view]);

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
      setView('dashboard');
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
    setView('auth');
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
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !user || !selectedChapter) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const formData = new FormData();
      formData.append('chapterId', selectedChapter.id);
      formData.append('pageNumber', (pages.length + i + 1).toString());
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
          // Trigger refresh of pages after brief delay
          setTimeout(() => {
            fetch(`/api/chapters/${selectedChapter.id}/pages`, {
              headers: { 'Authorization': `Bearer ${user.token}` }
            })
            .then(r => r.json())
            .then(data => setPages(data));
          }, 1000);
        }
      } catch (err) {
        console.error("Failed to upload page", err);
      }
    }
  };

  // Set image natural dimensions for SVG scaling
  const handleImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setImageDims({
      w: e.currentTarget.naturalWidth,
      h: e.currentTarget.naturalHeight
    });
  };

  return (
    <div className="app-container">
      {/* Navigation Bar */}
      <nav className="nav-bar">
        <div className="logo" onClick={() => user && setView('dashboard')} style={{ cursor: user ? 'pointer' : 'default' }}>
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

      {/* Auth View */}
      {view === 'auth' && (
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
      )}

      {/* Dashboard View - Series Listing */}
      {view === 'dashboard' && (
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
                  setView('series');
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

          {/* New Series Modal */}
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
      )}

      {/* Series View - Chapter Listing */}
      {view === 'series' && selectedSeries && (
        <div className="dashboard-content">
          <div className="mb-8">
            <button className="btn btn-secondary" onClick={() => setView('dashboard')} style={{ padding: '8px 16px', marginBottom: '16px' }}>
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
                  setView('chapter');
                }}
                style={{ cursor: 'pointer' }}
              >
                <div className="chapter-title">Chapter {c.chapterNumber}: {c.title || 'Untitled'}</div>
                <button className="btn btn-text">Open Workspace &rarr;</button>
              </div>
            ))}
          </div>

          {/* New Chapter Modal */}
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
      )}

      {/* Chapter View - Page Upload and Thumbnails */}
      {view === 'chapter' && selectedSeries && selectedChapter && (
        <div className="dashboard-content">
          <div className="mb-8">
            <button className="btn btn-secondary" onClick={() => setView('series')} style={{ padding: '8px 16px', marginBottom: '16px' }}>
              &larr; Back to Series
            </button>
            <div className="page-header">
              <div>
                <h1>Chapter {selectedChapter.chapterNumber}</h1>
                <p style={{ color: 'var(--text-muted)', margin: '8px 0 0' }}>{selectedSeries.title} / {selectedChapter.title || 'Untitled'}</p>
              </div>
              <button className="btn btn-secondary" onClick={() => {
                // Refresh pages manually
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

          {/* Upload Area */}
          <div className="upload-dropzone" onClick={() => document.getElementById('file-upload')?.click()}>
            <svg className="upload-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <h3 style={{ margin: '0 0 8px' }}>Upload Manga Pages</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Drag and drop images, or click to browse</p>
            <input 
              id="file-upload" 
              type="file" 
              multiple 
              accept="image/*" 
              style={{ display: 'none' }} 
              onChange={handleFileUpload} 
            />
          </div>

          {/* Pages Grid */}
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '22px' }}>Uploaded Pages ({pages.length})</h2>
          <div className="pages-grid">
            {pages.map(p => (
              <div 
                key={p.id} 
                className="page-thumbnail-container glass" 
                onClick={() => {
                  setSelectedPage(p);
                  setView('reader');
                }}
              >
                <img src={p.url} className="page-thumbnail" alt={`Page ${p.pageNumber}`} />
                <span className="page-num-tag">Page {p.pageNumber}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Interactive Reader View */}
      {view === 'reader' && selectedPage && (
        <div className="reader-container">
          {/* Reader Left */}
          <div className="reader-main">
            {isLoadingDetails ? (
              <div style={{ textAlign: 'center' }}>
                <div className="spinner"></div>
                <p>Loading panels and OCR analysis...</p>
              </div>
            ) : (
              <div className="manga-canvas-wrapper">
                <img 
                  src={selectedPage.url} 
                  alt={`Page ${selectedPage.pageNumber}`} 
                  className="reader-image" 
                  onLoad={handleImgLoad}
                />
                <svg 
                  className="svg-overlay"
                  viewBox={`0 0 ${imageDims.w} ${imageDims.h}`}
                  style={{ pointerEvents: 'auto' }}
                >
                  {/* Render Panel boxes */}
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

                  {/* Render OCR regions */}
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
                        {/* Bubble order tag */}
                        <g transform={`translate(${r.bboxX + 10}, ${r.bboxY + 10})`}>
                          <circle cx="0" cy="0" r="8" fill={isSelected ? 'var(--primary)' : 'var(--success)'} />
                          <text cx="0" cy="0" className="bubble-text-tag">{r.bubbleReadingOrder}</text>
                        </g>
                      </g>
                    );
                  })}
                </svg>
              </div>
            )}
          </div>

          {/* Reader Sidebar */}
          <div className="reader-sidebar">
            <button className="btn btn-secondary" onClick={() => setView('chapter')} style={{ marginBottom: '24px' }}>
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
      )}
    </div>
  );
}

export default App;
