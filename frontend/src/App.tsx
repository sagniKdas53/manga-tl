import React, {
  useState,
  useEffect,
  Suspense,
  useCallback,
  useMemo,
} from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  useNavigate,
  useLocation,
  matchPath,
} from "react-router-dom";

import { ThemeProvider } from "@mui/material/styles";
import Box from "@mui/material/Box";
import CssBaseline from "@mui/material/CssBaseline";
import CircularProgress from "@mui/material/CircularProgress";
import { themeObj } from "./theme";

// Types
import type { User, Series, Chapter, Page } from "./types";

// Utils & overrides
import { safeFetch, getContextPath } from "./utils";

// Providers
import { NotificationProvider } from "./components/NotificationContext";
import { ToastProvider, useToast } from "./components/ToastContext";
import { UploadProvider } from "./components/UploadContext";

// Static import for NotificationCenter (always present in nav)
import { useNotifications } from "./components/useNotifications";
import { NavBar } from "./components/NavBar";
import { useColorMode } from "./hooks/useColorMode";
import { useDependencyLogger } from "./hooks/useDependencyLogger";

// Lazy-loaded route components
const Auth = React.lazy(() => import("./components/Auth"));
const Dashboard = React.lazy(() => import("./components/Dashboard"));
const SeriesDetails = React.lazy(() => import("./components/SeriesDetails"));
const ChapterGallery = React.lazy(() => import("./components/ChapterGallery"));
const Reader = React.lazy(() => import("./components/Reader"));
const SettingsModal = React.lazy(() => import("./components/SettingsModal"));
const UserManagementModal = React.lazy(
  () => import("./components/UserManagementModal"),
);

// Stable identity for props that don't need per-render identities — keeps React.memo effective
const NOOP = () => undefined;

function LoadingSpinner() {
  return (
    <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60vh" }}>
      <CircularProgress />
    </Box>
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
  const [isUserModalOpen, setIsUserModalOpen] = useState(false);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);

  const { mode } = useColorMode();
  const appliedTheme = useMemo(() => themeObj(mode), [mode]);

  const [activeDrawer, setActiveDrawer] = useState<
    "none" | "queue" | "notifications"
  >("none");

  useEffect(() => {
    document.documentElement.classList.toggle("light", mode === "light");
    localStorage.setItem("manga_theme", mode);
  }, [mode]);

  useDependencyLogger(
    {
      user,
      seriesId,
      chapterId,
      seriesList,
      selectedSeries,
      chapters,
      selectedChapter,
      pages,
      isLoadingDetails,
      activeDrawer,
    },
    "AppContent"
  );

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

  const handleSettingsClose = useCallback(() => setIsSettingsOpen(false), []);

  return (
    <ThemeProvider theme={appliedTheme}>
      <CssBaseline />
      <Box
        sx={{
          bgcolor: "background.default",
          minHeight: "100dvh",
        }}
      >
        <NotificationProvider token={user?.token || null}>
          <ToastProvider>
            <UploadProvider>
              <GlobalErrorListener />
              <TranslationToastWatcher />
              <div className="app-container">
                {/* Navigation Bar */}
                {!readerMatch && (
                  <NavBar
                    user={user}
                    activeDrawer={activeDrawer}
                    setActiveDrawer={setActiveDrawer}
                    setIsSettingsOpen={setIsSettingsOpen}
                    setIsUserModalOpen={setIsUserModalOpen}
                    handleLogout={handleLogout}
                  />
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
                          <Dashboard
                            user={user}
                            seriesList={seriesList}
                            setSeriesList={setSeriesList}
                            onSelectSeries={setSelectedSeries}
                            mode={mode}
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
                            onSelectPage={NOOP}
                            isLoadingDetails={isLoadingDetails}
                            mode={mode}
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
                            onSelectPage={NOOP}
                            isLoadingDetails={isLoadingDetails}
                            mode={mode}
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
                            selectedSeries={selectedSeries}
                            selectedChapter={selectedChapter}
                            chapters={chapters}
                            pages={pages}
                            setPages={setPages}
                            theme={mode}
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
                            selectedSeries={selectedSeries}
                            selectedChapter={selectedChapter}
                            chapters={chapters}
                            pages={pages}
                            setPages={setPages}
                            theme={mode}
                          />
                        ) : null
                      }
                    />
                  </Routes>
                </Suspense>

                <Suspense fallback={<LoadingSpinner />}>
                  {isSettingsOpen && (
                    <SettingsModal
                      isOpen={isSettingsOpen}
                      onClose={handleSettingsClose}
                      token={user?.token}
                    />
                  )}
                  {isUserModalOpen && user && (
                    <UserManagementModal
                      open={isUserModalOpen}
                      onClose={() => setIsUserModalOpen(false)}
                      user={user}
                      onUserUpdate={(updated) => {
                        setUser(updated);
                        localStorage.setItem(
                          "manga_user",
                          JSON.stringify(updated),
                        );
                      }}
                      onLogout={handleLogout}
                    />
                  )}
                </Suspense>
              </div>
            </UploadProvider>
          </ToastProvider>
        </NotificationProvider>
      </Box>
    </ThemeProvider>
  );
}

function App() {
  const cleanBaseName = getContextPath() || "/";

  return (
    <BrowserRouter basename={cleanBaseName}>
      <AppContent />
    </BrowserRouter>
  );
}

export default App;
