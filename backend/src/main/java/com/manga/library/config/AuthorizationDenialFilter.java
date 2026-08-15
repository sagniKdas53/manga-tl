package com.manga.library.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.lang.NonNull;
import org.springframework.security.authorization.AuthorizationDeniedException;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Keeps an authorization denial from being logged as a server fault.
 *
 * <p><b>What it costs to not have this.</b> Over one 65-minute window, 16 denials produced 1,922
 * lines of stack trace — 23% of everything the backend logged, at ERROR, where no log level could
 * suppress it and every one of them was a routine 403.
 *
 * <p><b>Why they escape.</b> All 16 came from the SSE stream's <em>async</em> dispatch, where
 * nothing re-established a {@code SecurityContext} and Spring Security's {@code AuthorizationFilter}
 * denied. {@link SseTicketAuthFilter} now restores the context on that dispatch, so the denial
 * should no longer occur at all — this filter is the net under it, and under any other committed
 * response that ends the same way.
 *
 * <p><b>Why a 403 cannot simply be sent.</b> {@code ExceptionTranslationFilter} does run on the
 * async dispatch, but by then an SSE response is committed, so it cannot convert the denial into a
 * 403. What it does instead is rethrow it <em>wrapped in a {@code ServletException}</em> carrying
 * "Unable to handle the Spring Security Exception because the response is already committed." That
 * wrapper is the reason this filter's original {@code catch (AuthorizationDeniedException)} never
 * fired: the exception arriving here is a {@code ServletException}, not the denial itself. It went
 * on to Tomcat's {@code StandardWrapperValve}, which logs any escaped exception at ERROR with the
 * full trace and marks the response 500 — verified against a running instance, where four SSE
 * terminations produced eight ~120-frame ERROR traces and four {@code 500}s in the access log.
 *
 * <p><b>What this does.</b> Catches at the outer edge of the chain, on async dispatches too
 * ({@link #shouldNotFilterAsyncDispatch()} is overridden for exactly that reason), unwraps the cause
 * chain, and turns a denial into one DEBUG line. Anything that is not a denial is rethrown
 * untouched. If the response has not been committed it also sends a 403, which is the status the
 * same denial already produces on the non-async path — so this makes the two paths agree rather than
 * inventing a new behaviour. Once an SSE stream has begun streaming the response is committed and
 * there is nothing left to send; the connection simply ends.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
public class AuthorizationDenialFilter extends OncePerRequestFilter {

  private static final Logger log = LoggerFactory.getLogger(AuthorizationDenialFilter.class);

  /** Bounds the cause walk. Nothing legitimate nests this deep; a cycle would otherwise hang. */
  private static final int MAX_CAUSE_DEPTH = 16;

  @Override
  protected void doFilterInternal(
      @NonNull HttpServletRequest request,
      @NonNull HttpServletResponse response,
      @NonNull FilterChain filterChain)
      throws ServletException, IOException {
    try {
      filterChain.doFilter(request, response);
    } catch (ServletException | RuntimeException e) {
      if (denialWithin(e) == null) {
        throw e;
      }
      if (response.isCommitted()) {
        // Typical for SSE: bytes are already on the wire, so the status cannot be changed and the
        // stream just ends. Nothing to do but decline to treat it as a server error.
        log.debug(
            "Authorization denied on an already-committed response for {} {} — connection ends here",
            request.getMethod(),
            request.getRequestURI());
      } else {
        log.debug(
            "Authorization denied for {} {}", request.getMethod(), request.getRequestURI());
        response.sendError(HttpServletResponse.SC_FORBIDDEN);
      }
    }
  }

  /**
   * Finds an {@link AuthorizationDeniedException} anywhere in {@code thrown}'s cause chain, or null
   * if there is none.
   *
   * <p>The chain has to be walked rather than the exception type matched, because the denial does
   * not always arrive bare: on a committed response {@code ExceptionTranslationFilter} rethrows it
   * inside a {@code ServletException}, which is exactly the case this filter exists for. Matching on
   * the outer type alone silently missed every SSE disconnect.
   */
  private static AuthorizationDeniedException denialWithin(Throwable thrown) {
    Throwable current = thrown;
    for (int depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth++) {
      if (current instanceof AuthorizationDeniedException denial) {
        return denial;
      }
      Throwable cause = current.getCause();
      current = (cause == current) ? null : cause;
    }
    return null;
  }

  /**
   * The whole point. The denials this exists to catch happen only on the async dispatch, which
   * {@link OncePerRequestFilter} skips by default.
   */
  @Override
  protected boolean shouldNotFilterAsyncDispatch() {
    return false;
  }
}
