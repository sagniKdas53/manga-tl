package com.manga.library.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Binds a {@code traceId} to every request so that the log lines it produces can be grepped as one
 * unit.
 *
 * <p>Ordered ahead of the security filter chain on purpose: authentication failures are exactly the
 * requests worth correlating, and a filter placed after security never runs for them.
 *
 * <p>An inbound {@value TraceContext#TRACE_HEADER} wins over a generated id. That is what stitches
 * the worker's callbacks into the pipeline they belong to — the worker sends the id it received in
 * the job payload, so all six stages of a page, across both containers, share one value. A request
 * without the header (a browser call) gets a fresh id covering just that request.
 *
 * <p>This filter does not run on async dispatches ({@link OncePerRequestFilter} declines them by
 * default and that default is left alone here). The SSE stream is the only async endpoint, and its
 * re-dispatch carries no useful trace: the interesting logging on that path happens on the initial
 * dispatch, which this filter does cover.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class TraceIdFilter extends OncePerRequestFilter {

  @Override
  protected void doFilterInternal(
      @NonNull HttpServletRequest request,
      @NonNull HttpServletResponse response,
      @NonNull FilterChain filterChain)
      throws ServletException, IOException {
    String inbound = request.getHeader(TraceContext.TRACE_HEADER);
    String traceId;
    if (inbound != null && !inbound.isBlank()) {
      // Cap the length: this is attacker-controlled input that is about to be written into every
      // log line for the duration of the request. A UUID is 36 characters.
      traceId = inbound.length() > 64 ? inbound.substring(0, 64) : inbound;
      TraceContext.put(traceId);
    } else {
      traceId = TraceContext.putNew();
    }
    try {
      response.setHeader(TraceContext.TRACE_HEADER, traceId);
      markIfProbe(request);
      filterChain.doFilter(request, response);
    } finally {
      TraceContext.clear();
    }
  }

  /**
   * Sets the request attribute named by {@code server.tomcat.accesslog.condition-unless}, which
   * suppresses the access-log line for this request.
   *
   * <p>Set here rather than in a filter of its own because this one already runs outermost on every
   * request. The access-log valve reads the attribute after the response completes, so a filter can
   * still influence it.
   *
   * <p>The targets are the two probes that dominate an idle stack: the compose healthcheck's 30s
   * poll of {@code /actuator/health} and the worker's own {@code /health}. They are pure background
   * noise in the log and their outcome is visible as the container's health status anyway. A
   * <em>failing</em> probe is not hidden by this — it shows up as the container going unhealthy, and
   * the health endpoint's own logging is untouched.
   */
  private void markIfProbe(HttpServletRequest request) {
    String path = request.getRequestURI();
    if (path == null) {
      return;
    }
    if (path.endsWith("/actuator/health") || path.endsWith("/health")) {
      request.setAttribute("skipAccessLog", Boolean.TRUE);
    }
  }
}
