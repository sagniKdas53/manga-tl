import React, { useState, useEffect, Suspense } from "react";
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import theme from './theme';
import { useColorScheme } from '@mui/material/styles';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import SettingsIcon from '@mui/icons-material/Settings';
import {
  BrowserRouter,
  Routes,
  Route,
  useNavigate,
  useLocation,
  matchPath,
} from "react-router-dom";

// Types
import type { User, Series, Chapter, Page } from "./types";

// Utils & overrides
import { safeFetch, getContextPath } from "./utils";

// Providers
import { NotificationProvider } from "./components/NotificationContext";
import { ToastProvider, useToast } from "./components/ToastContext";

// Static import for NotificationCenter (always present in nav)
import { NotificationCenter } from "./components/NotificationCenter";
import { QueueManager } from "./components/QueueManager";
import { useNotifications } from "./components/useNotifications";
import logoDark from "./assets/logo-dark.svg";
import logoLight from "./assets/logo-light.svg";

// Lazy-loaded route components
const Auth = React.lazy(() => import("./components/Auth"));
const Dashboard = React.lazy(() => import("./components/Dashboard"));
const SeriesDetails = React.lazy(() => import("./components/SeriesDetails"));
const ChapterGallery = React.lazy(() => import("./components/ChapterGallery"));
const Reader = React.lazy(() => import("./components/Reader"));
const SettingsModal = React.lazy(() => import("./components/SettingsModal"));

const MemoizedDashboard = React.memo(Dashboard);
const MemoizedSeriesDetails = React.memo(SeriesDetails);
const MemoizedChapterGallery = React.memo(ChapterGallery);
const MemoizedReader = React.memo(Reader);

function LoadingSpinner() {
  return (
    <div className="dashboard-content text-center">
      <div className="spinner"></div>
    </div>
  );
}

/** Watches the notification stream and fires a toast for translation-complete events,
 *  but only when the user is NOT in the Reader (Reader refreshes its own data). */
function TranslationToastWatcher() {
  const { notifications } = useNotifications();
  const { showToast } = useToast();
  const location = useLocation();

  const isInReader = !!(
    matchPath(
      { path: "/chapters/:chapterId/reader/:pageNumber" },
      location.pathname,
    ) ||
    matchPath(
      { path: "/chapters/:chapterId/:slug/reader/:pageNumber" },
      location.pathname,
    )
  );

  // Track which notification ids we've already toasted
  const seenRef = React.useRef<Set<string>>(new Set());

  useEffect(() => {
    if (isInReader) return;
    for (const n of notifications) {
      if (!seenRef.current.has(n.id)) {
        seenRef.current.add(n.id);
        // Only toast on the very first time we see it (i.e. it's new)
        if (
          n.title?.toLowerCase().includes("translation") ||
          n.message?.toLowerCase().includes("translation")
        ) {
          const type =
            n.type === "ERROR"
              ? "error"
              : n.type === "WARNING"
                ? "info"
                : "success";
          showToast(`${n.title}: ${n.message}`, type);
        }
      }
    }
  }, [notifications, isInReader, showToast]);

  return null;
}

function ThemeSync() {
  const { mode, setMode } = useColorScheme();
  useEffect(() => {
    const saved = localStorage.getItem('manga_theme');
    if (saved === 'light' && mode !== 'light') setMode('light');
    else if (!saved && mode !== 'dark') setMode('dark');
  }, []);
  useEffect(() => {
    if (mode) localStorage.setItem('manga_theme', mode);
  }, [mode]);
  return null;
}

function GlobalErrorListener() {
  const { showError } = useToast();
  useEffect(() => {
    const handleApiError = (e: Event) => {
      const customEvent = e as CustomEvent;
      showError(`API request failed: ${customEvent.detail.url}`, {
        duration: 6000,
      });
    };
    window.addEventListener("api-error", handleApiError);
    return () => window.removeEventListener("api-error", handleApiError);
  }, [showError]);
  return null;
}

function AppContent() {
  const navigate = useNavigate();
  const location = useLocation();

  // Match URL params for deep routing
  const seriesMatch =
    matchPath({ path: "/series/:seriesId/*" }, location.pathname) ||
    matchPath({ path: "/series/:seriesId" }, location.pathname);
  const chapterMatch =
    matchPath({ path: "/chapters/:chapterId/*" }, location.pathname) ||
    matchPath({ path: "/chapters/:chapterId" }, location.pathname);

  const readerMatch =
    matchPath(
      { path: "/chapters/:chapterId/:slug/reader/:pageNumber" },
      location.pathname,
    ) ||
    matchPath(
      { path: "/chapters/:chapterId/reader/:pageNumber" },
      location.pathname,
    );

  const seriesId = seriesMatch?.params.seriesId;
  const chapterId = chapterMatch?.params.chapterId;

  // Authentication state initialized directly from localStorage to satisfy linter and prevent cascading renders
  const [user, setUser] = useState<User | null>(() => {
    const storedUser = localStorage.getItem("manga_user");
    if (storedUser) {
      try {
        return JSON.parse(storedUser);
      } catch {
        localStorage.removeItem("manga_user");
      }
    }
    return null;
  });

  // Domain States
  const [seriesList, setSeriesList] = useState<Series[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<Series | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);

  // Theme State & Persistence
  const { mode, setMode } = useColorScheme();
  const theme = mode === "light" ? "light" : "dark";
  const setTheme = (newTheme: "light" | "dark") => {
    setMode(newTheme);
  };

  // Load user session redirect
  useEffect(() => {
    if (!user && location.pathname !== "/login") {
      navigate("/login", { replace: true });
    } else if (user && location.pathname === "/login") {
      navigate("/", { replace: true });
    }
  }, [user, location.pathname, navigate]);

  // Fetch Series List (Dashboard)
  useEffect(() => {
    if (user && location.pathname === "/") {
      safeFetch("/api/series", {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((res) => {
          if (!res.ok) throw new Error("Failed to fetch series list");
          return res.json();
        })
        .then((data) => {
          if (Array.isArray(data)) {
            setSeriesList(data);
          }
        })
        .catch((err) => console.error("Error fetching series:", err));
    }
  }, [user, location.pathname]);

  // Load series details and chapters when seriesId is active in route
  useEffect(() => {
    if (user && seriesId) {
      Promise.resolve().then(() => {
        setSelectedSeries((prev) => {
          if (!prev || prev.id !== seriesId) {
            setIsLoadingDetails(true);
          }
          return prev;
        });
      });

      Promise.all([
        safeFetch(`/api/series/${seriesId}`, {
          headers: { Authorization: `Bearer ${user.token}` },
        }).then((res) => {
          if (!res.ok) throw new Error("Series not found");
          return res.json();
        }),
        safeFetch(`/api/series/${seriesId}/chapters`, {
          headers: { Authorization: `Bearer ${user.token}` },
        }).then((res) => {
          if (!res.ok) throw new Error("Failed to fetch chapters");
          return res.json();
        }),
      ])
        .then(([seriesData, chaptersData]) => {
          setSelectedSeries(seriesData);
          if (Array.isArray(chaptersData)) {
            setChapters(chaptersData);
          }
          setIsLoadingDetails(false);
        })
        .catch((err) => {
          console.error("Error fetching series details:", err);
          setIsLoadingDetails(false);
        });
    }
  }, [seriesId, user]);

  // Load chapter details and pages when chapterId is active in route
  useEffect(() => {
    if (user && chapterId) {
      Promise.resolve().then(() => {
        setSelectedChapter((prev) => {
          if (!prev || prev.id !== chapterId) {
            setIsLoadingDetails(true);
          }
          return prev;
        });
      });

      safeFetch(`/api/series/chapters/${chapterId}`, {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((res) => {
          if (!res.ok) throw new Error("Chapter not found");
          return res.json();
        })
        .then((chapterData) => {
          setSelectedChapter(chapterData);
          return Promise.all([
            safeFetch(`/api/series/${chapterData.seriesId}`, {
              headers: { Authorization: `Bearer ${user.token}` },
            }).then((res) => {
              if (!res.ok) throw new Error("Series not found");
              return res.json();
            }),
            safeFetch(`/api/chapters/${chapterId}/pages`, {
              headers: { Authorization: `Bearer ${user.token}` },
            }).then((res) => {
              if (!res.ok) throw new Error("Failed to fetch pages");
              return res.json();
            }),
          ]);
        })
        .then(([seriesData, pagesData]) => {
          setSelectedSeries(seriesData);
          if (Array.isArray(pagesData)) {
            setPages(pagesData);
          }
          setIsLoadingDetails(false);
        })
        .catch((err) => {
          console.error("Error fetching chapter details:", err);
          setIsLoadingDetails(false);
        });
    }
  }, [chapterId, user]);

  // Dynamically manage browser tab title
  useEffect(() => {
    if (readerMatch) return;

    if (location.pathname === "/" || location.pathname === "/login") {
      document.title = "tl-hub - Home";
    } else if (seriesId && selectedSeries) {
      document.title = `tl-hub - ${selectedSeries.title}`;
    } else if (chapterId && selectedChapter) {
      const seriesTitle = selectedSeries ? selectedSeries.title : "Series";
      document.title = `tl-hub - ${seriesTitle} - Ch. ${selectedChapter.chapterNumber}`;
    } else {
      document.title = "tl-hub";
    }
  }, [
    location.pathname,
    seriesId,
    chapterId,
    selectedSeries,
    selectedChapter,
    readerMatch,
  ]);

  // Handle Logout
  const handleLogout = () => {
    localStorage.removeItem("manga_user");
    setUser(null);
    navigate("/login");
  };

  return (
    <NotificationProvider token={user?.token || null}>
      <ToastProvider>
        <GlobalErrorListener />
        <TranslationToastWatcher />
        <div className="app-container">
          {/* Navigation Bar */}
          {!readerMatch && (
            <AppBar position="static" color="default" elevation={1} sx={{ backgroundColor: 'var(--bg-glass)', backdropFilter: 'blur(10px)', backgroundImage: 'none', mb: 4 }}>
              <Toolbar>
                <Box
                  onClick={() => user && navigate("/")}
                  sx={{
                    cursor: user ? "pointer" : "default",
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    flexGrow: 1,
                  }}
                >
                  <img
                    src={theme === "dark" ? logoDark : logoLight}
                    alt="tl-hub logo"
                    style={{ height: "32px", width: "auto" }}
                  />
                  <Typography variant="h6" component="div" sx={{ fontWeight: 700, fontFamily: 'var(--font-display)' }}>
                    tl-hub
                  </Typography>
                </Box>
                
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Tooltip title={`Switch to ${theme === "dark" ? "Light" : "Dark"} Mode`}>
                    <IconButton onClick={() => setTheme(theme === "dark" ? "light" : "dark")} color="inherit">
                      {theme === "dark" ? <LightModeIcon /> : <DarkModeIcon />}
                    </IconButton>
                  </Tooltip>

                  {user && (
                    <>
                      <Tooltip title="Settings">
                        <IconButton onClick={() => setIsSettingsOpen(true)} color="inherit">
                          <SettingsIcon />
                        </IconButton>
                      </Tooltip>
                      <QueueManager token={user?.token} />
                      <NotificationCenter />
                      <Chip 
                        label={user.displayName}
                        variant="outlined"
                        sx={{ ml: 1, mr: 1, fontWeight: 'bold' }}
                      />
                      <Button
                        variant="outlined"
                        color="primary"
                        onClick={handleLogout}
                        size="small"
                        sx={{ textTransform: 'none' }}
                      >
                        Sign Out
                      </Button>
                    </>
                  )}
                </Box>
              </Toolbar>
            </AppBar>
          )}

          <Suspense fallback={<LoadingSpinner />}>
            <Routes>
              <Route
                path="/login"
                element={<Auth onLoginSuccess={setUser} />}
              />
              <Route
                path="/"
                element={
                  user ? (
                    <MemoizedDashboard
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
                    <MemoizedSeriesDetails
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
                    <MemoizedSeriesDetails
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
                    <MemoizedChapterGallery
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
                    <MemoizedChapterGallery
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
                    <MemoizedReader
                      user={user}
                      selectedSeries={selectedSeries}
                      selectedChapter={selectedChapter}
                      chapters={chapters}
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
                    <MemoizedReader
                      user={user}
                      selectedSeries={selectedSeries}
                      selectedChapter={selectedChapter}
                      chapters={chapters}
                      pages={pages}
                      theme={theme}
                    />
                  ) : null
                }
              />
            </Routes>
          </Suspense>

          <Suspense fallback={null}>
            {isSettingsOpen && (
              <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
                token={user?.token}
              />
            )}
          </Suspense>
        </div>
      </ToastProvider>
    </NotificationProvider>
  );
}

function App() {
  const cleanBaseName = getContextPath() || "/";

  return (
    <ThemeProvider theme={theme} defaultMode="dark">
      <CssBaseline />
      <ThemeSync />
      <BrowserRouter basename={cleanBaseName}>
        <AppContent />
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
