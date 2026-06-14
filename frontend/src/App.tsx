import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useLocation, matchPath } from 'react-router-dom';

// Types
import type { User, Series, Chapter, Page } from './types';

// Utils & overrides
import { safeFetch, getContextPath } from './utils';

// Components
import { Auth } from './components/Auth';
import { Dashboard } from './components/Dashboard';
import { SeriesDetails } from './components/SeriesDetails';
import { ChapterGallery } from './components/ChapterGallery';
import { Reader } from './components/Reader';

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

  // Authentication state initialized directly from localStorage to satisfy linter and prevent cascading renders
  const [user, setUser] = useState<User | null>(() => {
    const storedUser = localStorage.getItem('manga_user');
    if (storedUser) {
      try {
        return JSON.parse(storedUser);
      } catch (e) {
        localStorage.removeItem('manga_user');
      }
    }
    return null;
  });
  
  // Domain States
  const [seriesList, setSeriesList] = useState<Series[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<Series | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);

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

  // Load user session redirect
  useEffect(() => {
    if (!user && location.pathname !== '/login') {
      navigate('/login', { replace: true });
    } else if (user && location.pathname === '/login') {
      navigate('/', { replace: true });
    }
  }, [user, location.pathname, navigate]);

  // Fetch Series List (Dashboard)
  useEffect(() => {
    if (user && location.pathname === '/') {
      safeFetch('/api/series', {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(res => {
        if (!res.ok) throw new Error("Failed to fetch series list");
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data)) {
          setSeriesList(data);
        }
      })
      .catch(err => console.error("Error fetching series:", err));
    }
  }, [user, location.pathname]);

  // Load series details and chapters when seriesId is active in route
  useEffect(() => {
    if (user && seriesId) {
      if (!selectedSeries || selectedSeries.id !== seriesId) {
        // Defer loading details setting to avoid synchronous render warning
        Promise.resolve().then(() => {
          setIsLoadingDetails(true);
        });

        safeFetch(`/api/series/${seriesId}`, {
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

      safeFetch(`/api/series/${seriesId}/chapters`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(res => {
        if (!res.ok) throw new Error("Failed to fetch chapters");
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data)) {
          setChapters(data);
        }
      })
      .catch(err => console.error("Error fetching chapters:", err));
    }
  }, [seriesId, user, selectedSeries?.id]);

  // Load chapter details and pages when chapterId is active in route
  useEffect(() => {
    if (user && chapterId) {
      if (!selectedChapter || selectedChapter.id !== chapterId) {
        Promise.resolve().then(() => {
          setIsLoadingDetails(true);
        });

        safeFetch(`/api/series/chapters/${chapterId}`, {
          headers: { 'Authorization': `Bearer ${user.token}` }
        })
        .then(res => {
          if (!res.ok) throw new Error("Chapter not found");
          return res.json();
        })
        .then(chapterData => {
          setSelectedChapter(chapterData);
          return safeFetch(`/api/series/${chapterData.seriesId}`, {
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

      safeFetch(`/api/chapters/${chapterId}/pages`, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      })
      .then(res => {
        if (!res.ok) throw new Error("Failed to fetch pages");
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data)) {
          setPages(data);
        }
      })
      .catch(err => console.error("Error fetching pages:", err));
    }
  }, [chapterId, user, selectedChapter?.id]);

  // Handle Logout
  const handleLogout = () => {
    localStorage.removeItem('manga_user');
    setUser(null);
    navigate('/login');
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
        <Route path="/login" element={<Auth onLoginSuccess={setUser} />} />
        <Route 
          path="/" 
          element={
            user ? (
              <Dashboard 
                user={user} 
                seriesList={seriesList} 
                setSeriesList={setSeriesList} 
                onSelectSeries={setSelectedSeries} 
              />
            ) : null
          } 
        />
        <Route 
          path="/series/:seriesId" 
          element={
            user ? (
              <SeriesDetails 
                user={user} 
                selectedSeries={selectedSeries} 
                setSelectedSeries={setSelectedSeries} 
                chapters={chapters} 
                setChapters={setChapters} 
                onSelectChapter={setSelectedChapter} 
                isLoadingDetails={isLoadingDetails} 
              />
            ) : null
          } 
        />
        <Route 
          path="/series/:seriesId/:slug" 
          element={
            user ? (
              <SeriesDetails 
                user={user} 
                selectedSeries={selectedSeries} 
                setSelectedSeries={setSelectedSeries} 
                chapters={chapters} 
                setChapters={setChapters} 
                onSelectChapter={setSelectedChapter} 
                isLoadingDetails={isLoadingDetails} 
              />
            ) : null
          } 
        />
        <Route 
          path="/chapters/:chapterId" 
          element={
            user ? (
              <ChapterGallery 
                user={user} 
                selectedSeries={selectedSeries} 
                selectedChapter={selectedChapter} 
                setSelectedChapter={setSelectedChapter} 
                pages={pages} 
                setPages={setPages} 
                onSelectPage={() => {}} 
                isLoadingDetails={isLoadingDetails} 
              />
            ) : null
          } 
        />
        <Route 
          path="/chapters/:chapterId/:slug" 
          element={
            user ? (
              <ChapterGallery 
                user={user} 
                selectedSeries={selectedSeries} 
                selectedChapter={selectedChapter} 
                setSelectedChapter={setSelectedChapter} 
                pages={pages} 
                setPages={setPages} 
                onSelectPage={() => {}} 
                isLoadingDetails={isLoadingDetails} 
              />
            ) : null
          } 
        />
        <Route 
          path="/chapters/:chapterId/reader/:pageNumber" 
          element={
            user ? (
              <Reader 
                user={user} 
                selectedChapter={selectedChapter} 
                pages={pages} 
                theme={theme} 
              />
            ) : null
          } 
        />
        <Route 
          path="/chapters/:chapterId/:slug/reader/:pageNumber" 
          element={
            user ? (
              <Reader 
                user={user} 
                selectedChapter={selectedChapter} 
                pages={pages} 
                theme={theme} 
              />
            ) : null
          } 
        />
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
