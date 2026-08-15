package com.manga.library.config;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.slf4j.MDC;

/** AUDIT-L2, and the SpotBugs {@code HRS_REQUEST_PARAMETER_TO_HTTP_HEADER} it originally tripped. */
public class TraceIdFilterTest {

  private final TraceIdFilter filter = new TraceIdFilter();

  @AfterEach
  public void clearMdc() {
    MDC.clear();
  }

  /**
   * The propagation this filter exists for: the worker sends the pipeline's id on its callbacks, and
   * the backend must log under that id rather than invent its own — otherwise the two containers'
   * logs cannot be joined, which is the whole point.
   */
  @Test
  public void testWellFormedInboundTraceIdIsAdopted() throws Exception {
    String inbound = "661fbe37-5dec-4b17-823b-39d915dbdc76";
    HttpServletRequest request = mock(HttpServletRequest.class);
    HttpServletResponse response = mock(HttpServletResponse.class);
    when(request.getHeader(TraceContext.TRACE_HEADER)).thenReturn(inbound);
    when(request.getRequestURI()).thenReturn("/tlhub/api/internal/jobs/callback/ocr");

    String[] seen = new String[1];
    FilterChain chain = (req, res) -> seen[0] = TraceContext.current();

    filter.doFilter(request, response, chain);

    assertEquals(inbound, seen[0], "the inbound id should be bound for the request");
    verify(response).setHeader(TraceContext.TRACE_HEADER, inbound);
  }

  /**
   * A caller-supplied id reaches two places that punish a newline: the response header (response
   * splitting — the caller ends the header block and dictates the rest of the response) and, through
   * the MDC, every log line the request writes. The second is the sharper one: a CR/LF lets a caller
   * forge entries that look like the backend's own, in the log that is being trusted to explain what
   * happened.
   *
   * <p>Rejected input must not merely be escaped into the header — it must not reach it at all.
   */
  @ParameterizedTest
  @ValueSource(
      strings = {
        "abc\r\nX-Injected: evil",
        "abc\nSet-Cookie: session=stolen",
        "abc\rLocation: http://evil.example",
        "has spaces",
        "semi;colon",
        "<script>alert(1)</script>",
        "  ",
        "0123456789012345678901234567890123456789012345678901234567890123456789" // 70 chars
      })
  public void testMalformedInboundTraceIdIsReplacedRatherThanEchoed(String hostile)
      throws Exception {
    HttpServletRequest request = mock(HttpServletRequest.class);
    HttpServletResponse response = mock(HttpServletResponse.class);
    when(request.getHeader(TraceContext.TRACE_HEADER)).thenReturn(hostile);
    when(request.getRequestURI()).thenReturn("/tlhub/api/series");

    String[] seen = new String[1];
    FilterChain chain = (req, res) -> seen[0] = TraceContext.current();

    filter.doFilter(request, response, chain);

    assertNotNull(seen[0], "a request still gets traced, just not under a name it chose");
    assertNotEquals(hostile, seen[0]);
    verify(response, never()).setHeader(eq(TraceContext.TRACE_HEADER), eq(hostile));
    // Whatever was issued instead must itself be header-safe and log-safe.
    assertFalse(seen[0].contains("\r"));
    assertFalse(seen[0].contains("\n"));
  }

  /**
   * The MDC is a thread-local and Tomcat's exec pool is reused, so an id left bound after the
   * response would label whatever unrelated request landed on that thread next — worse than having
   * no id, because it reads as real.
   */
  @Test
  public void testTraceIdIsClearedAfterTheRequest() throws Exception {
    HttpServletRequest request = mock(HttpServletRequest.class);
    HttpServletResponse response = mock(HttpServletResponse.class);
    when(request.getRequestURI()).thenReturn("/tlhub/api/series");

    filter.doFilter(request, response, (req, res) -> {});

    assertNull(TraceContext.current(), "the MDC must not outlive the request");
  }

  /** Still cleared when the chain throws, or the next request on this thread inherits the id. */
  @Test
  public void testTraceIdIsClearedWhenTheChainThrows() {
    HttpServletRequest request = mock(HttpServletRequest.class);
    HttpServletResponse response = mock(HttpServletResponse.class);
    when(request.getRequestURI()).thenReturn("/tlhub/api/series");

    assertThrows(
        RuntimeException.class,
        () ->
            filter.doFilter(
                request,
                response,
                (req, res) -> {
                  throw new RuntimeException("boom");
                }));

    assertNull(TraceContext.current());
  }

  /**
   * The compose healthcheck and the worker's poll are most of the access log on an idle stack. The
   * attribute named here is what {@code server.tomcat.accesslog.condition-unless} reads.
   */
  @Test
  public void testProbeRequestsAreMarkedForAccessLogSuppression() throws Exception {
    HttpServletRequest request = mock(HttpServletRequest.class);
    HttpServletResponse response = mock(HttpServletResponse.class);
    when(request.getRequestURI()).thenReturn("/tlhub/actuator/health");

    filter.doFilter(request, response, (req, res) -> {});

    verify(request).setAttribute("skipAccessLog", Boolean.TRUE);
  }

  @Test
  public void testOrdinaryRequestsAreNotSuppressed() throws Exception {
    HttpServletRequest request = mock(HttpServletRequest.class);
    HttpServletResponse response = mock(HttpServletResponse.class);
    when(request.getRequestURI()).thenReturn("/tlhub/api/series");

    filter.doFilter(request, response, (req, res) -> {});

    verify(request, never()).setAttribute(eq("skipAccessLog"), any());
  }
}
