package com.manga.library.config;

import static org.junit.jupiter.api.Assertions.*;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authorization.AuthorizationDeniedException;

/**
 * AUDIT-L3.
 *
 * <p>The filter shipped without a test and the gap it left was not theoretical: on a running
 * instance it caught nothing at all, because {@code ExceptionTranslationFilter} wraps the denial in
 * a {@code ServletException} once the response is committed, and the original {@code catch} named
 * only {@link AuthorizationDeniedException}. Four SSE terminations still produced eight ~120-frame
 * ERROR traces and four {@code 500}s. {@link #swallowsADenialWrappedOnACommittedResponse} is that
 * regression; the rethrow cases below are what keeps the broadened catch from swallowing real
 * faults.
 */
public class AuthorizationDenialFilterTest {

  private final AuthorizationDenialFilter filter = new AuthorizationDenialFilter();

  private static MockHttpServletRequest streamRequest() {
    return new MockHttpServletRequest("GET", "/api/notifications/stream");
  }

  private static FilterChain throwing(RuntimeException toThrow) {
    return (req, res) -> {
      throw toThrow;
    };
  }

  private static FilterChain throwing(ServletException toThrow) {
    return (req, res) -> {
      throw toThrow;
    };
  }

  /**
   * The regression. This is the exact shape Tomcat logged at ERROR once per SSE disconnect: the
   * denial arrives inside the {@code ServletException} that {@code ExceptionTranslationFilter}
   * raises when it finds the response already committed and cannot turn the denial into a 403.
   */
  @Test
  public void swallowsADenialWrappedOnACommittedResponse() throws Exception {
    MockHttpServletResponse response = new MockHttpServletResponse();
    response.setCommitted(true);
    ServletException wrapped =
        new ServletException(
            "Unable to handle the Spring Security Exception because the response is already committed.",
            new AuthorizationDeniedException("Access Denied"));

    assertDoesNotThrow(
        () -> filter.doFilter(streamRequest(), response, throwing(wrapped)),
        "a wrapped denial must not escape to Tomcat, which logs it at ERROR and marks it 500");
    assertEquals(
        200,
        response.getStatus(),
        "the stream was streaming fine; its status must not be rewritten on the way out");
  }

  /** The non-async path's behaviour, which the async path is supposed to agree with. */
  @Test
  public void sendsA403WhenTheResponseIsStillOpen() throws Exception {
    MockHttpServletResponse response = new MockHttpServletResponse();

    filter.doFilter(
        streamRequest(), response, throwing(new AuthorizationDeniedException("Access Denied")));

    assertEquals(403, response.getStatus());
  }

  /** Wrapping should not change the outcome when there is still a response to send. */
  @Test
  public void sendsA403WhenAWrappedDenialArrivesBeforeCommit() throws Exception {
    MockHttpServletResponse response = new MockHttpServletResponse();
    ServletException wrapped =
        new ServletException("wrapped", new AuthorizationDeniedException("Access Denied"));

    filter.doFilter(streamRequest(), response, throwing(wrapped));

    assertEquals(403, response.getStatus());
  }

  /** Found however deeply {@code ServletException} nesting buries it. */
  @Test
  public void findsADenialNestedSeveralLevelsDown() throws Exception {
    MockHttpServletResponse response = new MockHttpServletResponse();
    ServletException nested =
        new ServletException(
            "outer",
            new IllegalStateException(
                "middle", new AuthorizationDeniedException("Access Denied")));

    filter.doFilter(streamRequest(), response, throwing(nested));

    assertEquals(403, response.getStatus());
  }

  /**
   * The cost of broadening the catch, and the reason it unwraps rather than swallowing by type: a
   * genuine server fault must still reach the container and still be logged as one.
   */
  @Test
  public void rethrowsAServletExceptionThatIsNotADenial() {
    ServletException unrelated = new ServletException("handler blew up", new IllegalStateException("boom"));

    ServletException thrown =
        assertThrows(
            ServletException.class,
            () -> filter.doFilter(streamRequest(), new MockHttpServletResponse(), throwing(unrelated)));
    assertSame(unrelated, thrown);
  }

  @Test
  public void rethrowsAnUnrelatedRuntimeException() {
    IllegalStateException unrelated = new IllegalStateException("boom");

    IllegalStateException thrown =
        assertThrows(
            IllegalStateException.class,
            () -> filter.doFilter(streamRequest(), new MockHttpServletResponse(), throwing(unrelated)));
    assertSame(unrelated, thrown);
  }

  /** A cyclic cause chain must terminate the walk rather than hang the request. */
  @Test
  public void survivesACyclicCauseChain() {
    ServletException outer = new ServletException("outer");
    IllegalStateException inner = new IllegalStateException("inner");
    inner.initCause(outer);
    outer.initCause(inner);

    assertThrows(
        ServletException.class,
        () -> filter.doFilter(streamRequest(), new MockHttpServletResponse(), throwing(outer)));
  }

  @Test
  public void passesACleanRequestThrough() throws Exception {
    MockHttpServletResponse response = new MockHttpServletResponse();
    boolean[] reached = {false};

    filter.doFilter(streamRequest(), response, (req, res) -> reached[0] = true);

    assertTrue(reached[0]);
    assertEquals(200, response.getStatus());
  }
}
