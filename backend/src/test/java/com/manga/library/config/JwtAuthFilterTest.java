package com.manga.library.config;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.manga.library.repository.UserRepository;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/** AUDIT-B8. */
public class JwtAuthFilterTest {

  /**
   * The entry filed this as "fills the placeholder with {@code e.toString()} instead of attaching
   * the throwable, so no stack trace is ever logged". That is backwards. The inherited {@code
   * logger} is a commons-logging {@code Log} from {@code GenericFilterBean}, whose only two-arg
   * overload is {@code error(Object, Throwable)} — so the throwable was always attached and the
   * stack trace was always written. What never worked is the {@code {}}: commons-logging does not
   * interpolate, so it printed literally.
   *
   * <p>Both halves are asserted here on purpose. The throwable assertion passes with the defect in
   * place — that is the evidence the entry was misdiagnosed — and the message assertion is the one
   * that actually goes red.
   */
  @Test
  public void testAuthenticationFailure_LogsACleanMessageWithTheThrowableAttached() throws Exception {
    JwtUtils jwtUtils = mock(JwtUtils.class);
    UserRepository userRepository = mock(UserRepository.class);
    JwtAuthFilter filter = new JwtAuthFilter(jwtUtils, userRepository);

    HttpServletRequest request = mock(HttpServletRequest.class);
    HttpServletResponse response = mock(HttpServletResponse.class);
    FilterChain chain = mock(FilterChain.class);
    when(request.getHeader("Authorization")).thenReturn("Bearer a.b.c");
    when(jwtUtils.validateToken(anyString())).thenThrow(new IllegalStateException("bad key"));

    ch.qos.logback.classic.Logger logger =
        (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(JwtAuthFilter.class);
    ListAppender<ILoggingEvent> appender = new ListAppender<>();
    appender.start();
    Level previous = logger.getLevel();
    logger.setLevel(Level.ERROR);
    logger.addAppender(appender);
    try {
      filter.doFilter(request, response, chain);

      ILoggingEvent event =
          appender.list.stream()
              .filter(e -> e.getFormattedMessage().contains("Cannot set user authentication"))
              .findFirst()
              .orElseThrow(() -> new AssertionError("the failure was not logged at all"));

      assertFalse(
          event.getFormattedMessage().contains("{}"),
          "an uninterpolated {} reached the log: " + event.getFormattedMessage());
      assertNotNull(
          event.getThrowableProxy(), "the exception was not attached, so there is no stack trace");
      assertEquals("java.lang.IllegalStateException", event.getThrowableProxy().getClassName());
    } finally {
      logger.detachAppender(appender);
      logger.setLevel(previous);
    }

    // The chain must still run — a failed authentication is anonymous, not a dropped request.
    verify(chain, times(1)).doFilter(request, response);
  }
}
