import React, { useState, useEffect, Suspense, useCallback } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  useNavigate,
  useLocation,
  matchPath,
} from "react-router-dom";

import { ThemeProvider, useColorScheme } from "@mui/material/styles";
import Box from "@mui/material/Box";
import CssBaseline from "@mui/material/CssBaseline";
import CircularProgress from "@mui/material/CircularProgress";
import CardGridSkeleton from "./components/CardGridSkeleton";
import { theme } from "./theme";

// Types
import type { User, Series, Chapter, Page } from "./types";

// Utils & overrides
import {
  safeFetch,
  getContextPath,
  ensureFreshToken,
  msUntilRenewal,
  isTokenExpired,
  SESSION_EXPIRED_EVENT,
  TOKEN_REFRESHED_EVENT,
} from "./utils";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Providers
import { NotificationProvider } from "./components/NotificationContext";
import { ToastProvider, useToast } from "./components/ToastContext";
import { UploadProvider } from "./components/UploadContext";

// Static import for NotificationCenter (always present in nav)
import { useNotifications } from "./components/useNotifications";
import { NavBar } from "./components/NavBar";
import { useColorMode } from "./hooks/useColorMode";
import { useDependencyLogger } from "./hooks/useDependencyLogger";
import { usePaginatedResource } from "./hooks/usePaginatedResource";

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
    <Box
      sx={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "60vh",
      }}
    >
      <CircularProgress />
    </Box>
  );
}

/** The reader is a canvas, not a grid — a card skeleton would be a lie about what is coming. */
const isGridRoute = (pathname: string) =>
  !pathname.includes("/reader/") &&
  (pathname === "/" ||
    pathname.startsWith("/series/") ||
    pathname.startsWith("/chapters/"));

/**
 * Route-shaped Suspense fallback. One boundary covers every lazy route, so the fallback has to
 * pick its own shape rather than each route declaring one.
 */
function RouteFallback({ pathname }: { pathname: string }) {
  return isGridRoute(pathname) ? <CardGridSkeleton /> : <LoadingSpinner />;
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

interface SessionWatcherProps {
  /** The token currently in React state — re-arms the renewal timer when it changes. */
  token: string | null;
  onTokenRefreshed: (token: string) => void;
  onSessionEnd: () => void;
}

/**
 * Owns the session's lifetime while the app is open: keeps the token renewed, keeps React's copy
 * of it in step with storage, and turns an expiry into a visible sign-out instead of a screen
 * whose every request quietly fails.
 */
function SessionWatcher({
  token,
  onTokenRefreshed,
  onSessionEnd,
}: SessionWatcherProps) {
  const { showInfo } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    const handleRefreshed = (e: Event) => {
      onTokenRefreshed((e as CustomEvent).detail.token);
    };

    const handleExpired = (e: Event) => {
      // Claims the sign-out: the router handles it, so `utils` skips its hard-redirect fallback.
      e.preventDefault();
      onSessionEnd();
      navigate("/login", { replace: true });
      showInfo("Your session expired. Please sign in again.", {
        duration: 8000,
      });
    };

    window.addEventListener(TOKEN_REFRESHED_EVENT, handleRefreshed);
    window.addEventListener(SESSION_EXPIRED_EVENT, handleExpired);
    return () => {
      window.removeEventListener(TOKEN_REFRESHED_EVENT, handleRefreshed);
      window.removeEventListener(SESSION_EXPIRED_EVENT, handleExpired);
    };
  }, [onTokenRefreshed, onSessionEnd, navigate, showInfo]);

  useEffect(() => {
    if (!token) return;

    let renewalTimer: ReturnType<typeof setTimeout> | undefined;

    // One timer, aimed at the moment renewal comes due — for a 24-hour token that is a single
    // wake-up a day, not a poll. A successful renewal changes `token`, which re-runs this effect
    // and re-arms it; the reschedule below only has to cover the cases that do not, i.e. a
    // renewal that failed or a delay that had to be clamped.
    const arm = () => {
      clearTimeout(renewalTimer);
      const delay = msUntilRenewal();
      if (delay === null) return;
      renewalTimer = setTimeout(() => void ensureFreshToken().then(arm), delay);
    };

    // A frozen tab runs no timers at all, so the moment the app comes back is the one chance to
    // renew before anything is fetched with a token that went stale while it was away.
    const onWake = () => {
      if (document.visibilityState === "visible")
        void ensureFreshToken().then(arm);
    };

    // Unconditional at mount: the timer has to be armed even if the app rendered while hidden.
    void ensureFreshToken().then(arm);
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onWake);

    return () => {
      clearTimeout(renewalTimer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [token]);

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

/**
 * AUDIT-F1: syncs `useColorMode`'s mode (the app's own localStorage-backed, cross-tab-synced
 * source of truth — unchanged) onto MUI's own color scheme, which flips CSS custom properties
 * rather than rebuilding the theme object. `useColorScheme()` reads the `ThemeProvider`
 * context, so this has to be a child of it rather than called in `AppContent` itself, which is
 * what renders the provider.
 */
function ColorSchemeSync({ mode }: { mode: "light" | "dark" }) {
  const { setMode } = useColorScheme();
  useEffect(() => {
    setMode(mode);
  }, [mode, setMode]);
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
        const parsed: User = JSON.parse(storedUser);
        // An already-expired token cannot be renewed and every request made with it will 401.
        // Starting logged out shows the login form; starting "logged in" shows an app whose
        // panels stay empty with no explanation.
        if (parsed?.token && isTokenExpired(parsed.token)) {
          localStorage.removeItem("manga_user");
          return null;
        }
        return parsed;
      } catch {
        localStorage.removeItem("manga_user");
      }
    }
    return null;
  });

  // Domain States
  const [selectedSeries, setSelectedSeries] = useState<Series | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isUserModalOpen, setIsUserModalOpen] = useState(false);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);

  // AUDIT-F8: sort controls live here, not in Dashboard/SeriesDetails, because the fetch
  // they steer is server-side now — a client-side re-sort of a partial infinite-scroll
  // prefix would just be wrong. Both persist to the same localStorage keys the UI already
  // used, so an existing user's preference survives the migration.
  const [seriesSortBy, setSeriesSortBy] = useState<"createdAt" | "updatedAt">(
    () => {
      const saved = localStorage.getItem("dashboard_sort_by");
      return saved === "createdAt" ? "createdAt" : "updatedAt";
    },
  );
  const [seriesSortDir, setSeriesSortDir] = useState<"asc" | "desc">(() => {
    const saved = localStorage.getItem("dashboard_sort_dir");
    return saved === "asc" ? "asc" : "desc";
  });
  const [chaptersSortAsc, setChaptersSortAsc] = useState<boolean>(() => {
    const cached = localStorage.getItem("chapters_sort_asc");
    return cached === null ? true : cached === "true";
  });
  const [pagesSortAsc, setPagesSortAsc] = useState<boolean>(() => {
    const cached = localStorage.getItem("pages_sort_asc");
    return cached === null ? true : cached === "true";
  });

  const seriesPagination = usePaginatedResource<Series>(
    user && location.pathname === "/" ? "/api/series" : null,
    10,
    user?.token,
    [seriesSortBy, seriesSortDir],
    { params: { sortBy: seriesSortBy, sortDir: seriesSortDir } },
  );
  const seriesList = seriesPagination.items;
  const setSeriesList = seriesPagination.setItems;

  const chaptersPagination = usePaginatedResource<Chapter>(
    user && seriesId ? `/api/series/${seriesId}/chapters` : null,
    15,
    user?.token,
    [seriesId, chaptersSortAsc],
    { params: { sortDir: chaptersSortAsc ? "asc" : "desc" } },
  );
  const chapters = chaptersPagination.items;
  const setChapters = chaptersPagination.setItems;

  const pagesPagination = usePaginatedResource<Page>(
    user && chapterId ? `/api/chapters/${chapterId}/pages` : null,
    25,
    user?.token,
    [chapterId, pagesSortAsc],
    {
      params: { sortDir: pagesSortAsc ? "asc" : "desc" },
      // Batches can land out of order (the reader jumps straight to a page nobody scrolled
      // to), so the merged list is re-sorted here — in whichever direction the server was
      // asked for, or the two would disagree and the grid would show its own order.
      sortKey: (p) => (pagesSortAsc ? p.pageNumber : -p.pageNumber),
    },
  );
  const pages = pagesPagination.items;
  const setPages = pagesPagination.setItems;

  // The reader thinks in ascending page positions — "page 42" is the 42nd page of the
  // chapter regardless of how the gallery is sorted — but the batch that holds it depends on
  // the order the list was actually fetched in. Descending, the 42nd page lives in the batch
  // counted from the *other* end, so the position is mirrored before it is turned into a
  // batch index.
  const { ensureLoaded: ensurePageLoaded, totalCount: pagesTotalCount } =
    pagesPagination;
  const ensurePagePositionLoaded = useCallback(
    (position: number) => {
      ensurePageLoaded(
        pagesSortAsc ? position : Math.max(0, pagesTotalCount - 1 - position),
      );
    },
    [ensurePageLoaded, pagesSortAsc, pagesTotalCount],
  );

  const { mode } = useColorMode();

  const [activeDrawer, setActiveDrawer] = useState<
    "none" | "queue" | "notifications"
  >("none");

  // Reflects the mode onto the document. The write to `manga_theme` used to live here too, which
  // made two writers for one key -- `useColorMode.toggleMode` is the other, and the only one that
  // knows how to notify. This effect just mirrors; the hook owns the value.
  useEffect(() => {
    document.documentElement.classList.toggle("light", mode === "light");
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
    "AppContent",
  );

  // Load user session redirect
  useEffect(() => {
    if (!user && location.pathname !== "/login") {
      navigate("/login", { replace: true });
    } else if (user && location.pathname === "/login") {
      navigate("/", { replace: true });
    }
  }, [user, location.pathname, navigate]);

  // Series list fetch (page 0 onward) lives in `seriesPagination` above.

  // Load series details when seriesId is active in route. Chapters (page 0 onward) come
  // from `chaptersPagination` above — its own url/deps-driven effect handles the reset.
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

      safeFetch(`/api/series/${seriesId}`, {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((res) => {
          if (!res.ok) throw new Error("Series not found");
          return res.json();
        })
        .then((seriesData) => {
          setSelectedSeries(seriesData);
          setIsLoadingDetails(false);
        })
        .catch((err) => {
          console.error("Error fetching series details:", err);
          setIsLoadingDetails(false);
        });
    }
  }, [seriesId, user]);

  // Load chapter details when chapterId is active in route. Pages (page 0 onward) come
  // from `pagesPagination` above — its own url/deps-driven effect handles the reset.
  useEffect(() => {
    if (user && chapterId) {
      Promise.resolve().then(() => setIsLoadingDetails(true));

      safeFetch(`/api/series/chapters/${chapterId}`, {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((res) => {
          if (!res.ok) throw new Error("Chapter not found");
          return res.json();
        })
        .then((chapterData) => {
          setSelectedChapter(chapterData);
          return safeFetch(`/api/series/${chapterData.seriesId}`, {
            headers: { Authorization: `Bearer ${user.token}` },
          }).then((res) => {
            if (!res.ok) throw new Error("Series not found");
            return res.json();
          });
        })
        .then((seriesData) => {
          setSelectedSeries(seriesData);
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

  // A renewed token has to reach the components too — they send it as an explicit header, and
  // the copy they were rendered with is the one that is about to stop working.
  const handleTokenRefreshed = useCallback((token: string) => {
    setUser((prev) => (prev ? { ...prev, token } : prev));
  }, []);

  const handleSessionEnd = useCallback(() => setUser(null), []);

  return (
    <ThemeProvider
      theme={theme}
      defaultMode={mode}
    >
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
              <ColorSchemeSync mode={mode} />
              <GlobalErrorListener />
              <SessionWatcher
                token={user?.token ?? null}
                onTokenRefreshed={handleTokenRefreshed}
                onSessionEnd={handleSessionEnd}
              />
              <TranslationToastWatcher />
              <div className="app-container">
                {/*
                  The first focusable thing on the page: off-screen until focused, then
                  pinned to the top-left. Gives keyboard users a way past the nav that
                  does not depend on tabbing through every control in it.
                */}
                <Box
                  component="a"
                  href="#main-content"
                  sx={{
                    position: "absolute",
                    left: -9999,
                    top: 0,
                    zIndex: (t) => t.zIndex.tooltip + 1,
                    px: 2,
                    py: 1,
                    bgcolor: "background.paper",
                    color: "text.primary",
                    borderRadius: 1,
                    textDecoration: "none",
                    "&:focus": { left: 8, top: 8 },
                  }}
                >
                  Skip to main content
                </Box>
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

                {/*
                  The skip link's target, and the app's only `main` landmark. tabIndex -1
                  makes it programmatically focusable so the link actually moves focus
                  rather than just moving the viewport.
                */}
                <Box
                  component="main"
                  id="main-content"
                  tabIndex={-1}
                >
                  <ErrorBoundary resetKey={location.pathname}>
                    <Suspense
                      fallback={<RouteFallback pathname={location.pathname} />}
                    >
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
                                sortBy={seriesSortBy}
                                setSortBy={setSeriesSortBy}
                                sortDir={seriesSortDir}
                                setSortDir={setSeriesSortDir}
                                hasMore={seriesPagination.hasMore}
                                isLoadingMore={seriesPagination.isLoading}
                                onLoadMore={seriesPagination.loadMore}
                                loadError={seriesPagination.error}
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
                                sortAsc={chaptersSortAsc}
                                setSortAsc={setChaptersSortAsc}
                                hasMoreChapters={chaptersPagination.hasMore}
                                isLoadingMoreChapters={
                                  chaptersPagination.isLoading
                                }
                                onLoadMoreChapters={chaptersPagination.loadMore}
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
                                sortAsc={chaptersSortAsc}
                                setSortAsc={setChaptersSortAsc}
                                hasMoreChapters={chaptersPagination.hasMore}
                                isLoadingMoreChapters={
                                  chaptersPagination.isLoading
                                }
                                onLoadMoreChapters={chaptersPagination.loadMore}
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
                                pagesTotalCount={pagesPagination.totalCount}
                                hasMorePages={pagesPagination.hasMore}
                                isLoadingMorePages={pagesPagination.isLoading}
                                onLoadMorePages={pagesPagination.loadMore}
                                refreshPages={pagesPagination.refresh}
                                sortAsc={pagesSortAsc}
                                onToggleSort={() => {
                                  const nextSort = !pagesSortAsc;
                                  setPagesSortAsc(nextSort);
                                  localStorage.setItem(
                                    "pages_sort_asc",
                                    String(nextSort),
                                  );
                                }}
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
                                pagesTotalCount={pagesPagination.totalCount}
                                hasMorePages={pagesPagination.hasMore}
                                isLoadingMorePages={pagesPagination.isLoading}
                                onLoadMorePages={pagesPagination.loadMore}
                                refreshPages={pagesPagination.refresh}
                                sortAsc={pagesSortAsc}
                                onToggleSort={() => {
                                  const nextSort = !pagesSortAsc;
                                  setPagesSortAsc(nextSort);
                                  localStorage.setItem(
                                    "pages_sort_asc",
                                    String(nextSort),
                                  );
                                }}
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
                                pagesTotalCount={pagesPagination.totalCount}
                                ensurePageLoaded={ensurePagePositionLoaded}
                                refreshPages={pagesPagination.refresh}
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
                                pagesTotalCount={pagesPagination.totalCount}
                                ensurePageLoaded={ensurePagePositionLoaded}
                                refreshPages={pagesPagination.refresh}
                              />
                            ) : null
                          }
                        />
                      </Routes>
                    </Suspense>
                  </ErrorBoundary>
                </Box>

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
