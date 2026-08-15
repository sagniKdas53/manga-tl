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
 * <p><b>Why they escape.</b> All 16 came from the SSE stream's <em>async</em> dispatch.
 * {@link JwtAuthFilter#shouldNotFilterAsyncDispatch()} returns false, so the auth filters re-run
 * when Tomcat re-dispatches the async request; by then the single-use SSE ticket is spent and an
 * {@code EventSource} cannot send an {@code Authorization} header, so nothing re-establishes a
 * {@code SecurityContext} and Spring Security's {@code AuthorizationFilter} denies. Two things then
 * conspire: the throw happens inside the filter chain, where {@link GlobalExceptionHandler} — a
 * {@code @RestControllerAdvice}, which only sees exceptions that reach the DispatcherServlet's
 * handler resolution — cannot reach it, and {@code ExceptionTranslationFilter} does not process
 * async dispatches, so nothing converts the denial into a 403 response. It propagates to Tomcat's
 * {@code StandardWrapperValve}, which logs any escaped exception at ERROR with the full trace.
 *
 * <p><b>What this does.</b> Catches the denial at the outer edge of the chain, on async dispatches
 * too ({@link #shouldNotFilterAsyncDispatch()} is overridden for exactly that reason), and turns it
 * into one DEBUG line. If the response has not been committed it also sends a 403, which is the
 * status the same denial already produces on the non-async path — so this makes the two paths agree
 * rather than inventing a new behaviour. Once an SSE stream has begun streaming the response is
 * committed and there is nothing left to send; the connection simply ends.
 *
 * <p><b>What this does not fix.</b> The denial itself. The access log recorded that SSE stream
 * ending {@code "GET /tlhub/api/notifications/stream HTTP/1.1" 500}, meaning clients are having
 * streams terminated and reconnecting rather than closing cleanly. Silencing the trace makes that
 * legible instead of drowned; deciding whether the async re-authentication should be fixed (and how)
 * is tracked in TODO.md, because it is a change to how SSE authenticates, not to how it logs.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
public class AuthorizationDenialFilter extends OncePerRequestFilter {

  private static final Logger log = LoggerFactory.getLogger(AuthorizationDenialFilter.class);

  @Override
  protected void doFilterInternal(
      @NonNull HttpServletRequest request,
      @NonNull HttpServletResponse response,
      @NonNull FilterChain filterChain)
      throws ServletException, IOException {
    try {
      filterChain.doFilter(request, response);
    } catch (AuthorizationDeniedException e) {
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
   * The whole point. The denials this exists to catch happen only on the async dispatch, which
   * {@link OncePerRequestFilter} skips by default.
   */
  @Override
  protected boolean shouldNotFilterAsyncDispatch() {
    return false;
  }
}
