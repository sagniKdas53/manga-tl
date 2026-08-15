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
    if (isWellFormed(inbound)) {
      traceId = inbound;
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
   * Whether an inbound trace id may be adopted, rather than replaced with a generated one.
   *
   * <p>This value is caller-controlled and goes two places that both punish a newline: a response
   * header, and — via the MDC — every log line the request produces. SpotBugs flags the first as
   * {@code HRS_REQUEST_PARAMETER_TO_HTTP_HEADER} (HTTP response splitting: a CR/LF lets the caller
   * end the header block and dictate the rest of the response). The second is the one that matters
   * more here, because it is aimed at the thing this whole filter exists to provide — a CR/LF in the
   * id forges log lines, so an attacker could write entries that look like the backend's own and
   * make the log untrustworthy exactly where it is being trusted most.
   *
   * <p>An allowlist rather than an escape or a strip: the only legitimate senders are the worker and
   * this filter, both of which send a UUID. Anything that does not look like one has nothing to
   * contribute, so it is dropped and a fresh id issued — the request still gets traced, just not
   * under a name it chose. The 64-character cap keeps a caller from padding every log line.
   */
  private static boolean isWellFormed(String traceId) {
    if (traceId == null || traceId.isBlank() || traceId.length() > 64) {
      return false;
    }
    for (int i = 0; i < traceId.length(); i++) {
      char c = traceId.charAt(i);
      boolean allowed =
          (c >= 'a' && c <= 'z')
              || (c >= 'A' && c <= 'Z')
              || (c >= '0' && c <= '9')
              || c == '-'
              || c == '_';
      if (!allowed) {
        return false;
      }
    }
    return true;
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
