import React from "react";

/**
 * A crash inside the React tree unmounts the whole root and leaves an empty `<div id="root">` —
 * a blank page with nothing to click and nothing in the UI to explain it. Every route here is
 * `React.lazy`, and a lazy import rejects for perfectly ordinary reasons: the tab was restored
 * hours later on a flaky mobile connection, or the app was redeployed and the hashed chunk the
 * old document asks for no longer exists on the server. `React.lazy` caches that rejection, so
 * the route can never recover on its own.
 *
 * Deliberately dependency-free (no MUI, no theme, no router): this has to be able to render when
 * the thing that failed is the rest of the app.
 */
const CHUNK_LOAD_ERROR =
  /loading chunk|loading css chunk|dynamically imported module|importing a module script failed|failed to fetch dynamically imported module/i;

const RELOAD_GUARD_KEY = "manga_chunk_reload";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * Clears a caught error when this value changes — pass the current route so navigating away
   * from a page that crashed brings the app back. Only read while an error is showing, so the
   * healthy tree is never remounted by it.
   */
  resetKey?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

const isChunkLoadError = (error: unknown): boolean =>
  error instanceof Error &&
  (CHUNK_LOAD_ERROR.test(error.message) || error.name === "ChunkLoadError");

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      "[ErrorBoundary] Uncaught render error",
      error,
      info.componentStack,
    );

    // A stale document asking for deleted chunks is fixed by fetching the current one. Reload
    // once and only once — a guard in sessionStorage keeps a genuinely broken build from putting
    // the browser in a reload loop.
    if (isChunkLoadError(error) && !sessionStorage.getItem(RELOAD_GUARD_KEY)) {
      sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
      window.location.reload();
    }
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleReload = () => {
    sessionStorage.removeItem(RELOAD_GUARD_KEY);
    window.location.reload();
  };

  private handleSignOut = () => {
    localStorage.removeItem("manga_user");
    sessionStorage.removeItem(RELOAD_GUARD_KEY);
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const staleBuild = isChunkLoadError(error);

    return (
      <div
        role="alert"
        style={{
          minHeight: "60vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.75rem",
          padding: "2rem",
          textAlign: "center",
          fontFamily: "system-ui, sans-serif",
          color: "inherit",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1.25rem" }}>
          {staleBuild ? "This page is out of date" : "Something went wrong"}
        </h2>
        <p style={{ margin: 0, maxWidth: "32rem", opacity: 0.8 }}>
          {staleBuild
            ? "The app has been updated since this tab was opened, so part of it could not load. Reloading will fetch the current version."
            : "The page failed to render. Reloading usually clears it; if it keeps happening, signing out and back in resets the session."}
        </p>
        <code
          style={{ fontSize: "0.75rem", opacity: 0.6, wordBreak: "break-word" }}
        >
          {error.message}
        </code>
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: "0.5rem 1rem",
              cursor: "pointer",
              borderRadius: "0.375rem",
              border: "1px solid currentColor",
              background: "transparent",
              color: "inherit",
              font: "inherit",
            }}
          >
            Reload
          </button>
          <button
            type="button"
            onClick={this.handleSignOut}
            style={{
              padding: "0.5rem 1rem",
              cursor: "pointer",
              borderRadius: "0.375rem",
              border: "1px solid currentColor",
              background: "transparent",
              color: "inherit",
              font: "inherit",
              opacity: 0.7,
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
