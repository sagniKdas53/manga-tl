package com.manga.library.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.context.request.WebRequest;

/**
 * AUDIT-B3. {@code IllegalArgumentException} and {@code NullPointerException} shared one handler
 * that returned 400 and logged nothing. The intent was to catch {@code Objects.requireNonNull}
 * validation, but it also swallowed every genuine NPE in a controller path — reporting a server bug
 * to the client as their bad request, with no stack trace anywhere to find it by.
 */
public class GlobalExceptionHandlerTest {

  private GlobalExceptionHandler handler;
  private WebRequest request;

  @BeforeEach
  public void setUp() {
    handler = new GlobalExceptionHandler();
    request = mock(WebRequest.class);
    when(request.getDescription(false)).thenReturn("uri=/api/series/1");
  }

  @Test
  public void illegalArgument_isStillABadRequest_andKeepsItsMessage() {
    ProblemDetail pd =
        handler.handleBadRequest(new IllegalArgumentException("slug must not be blank"), request);

    assertThat(pd.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST.value());
    assertThat(pd.getTitle()).isEqualTo("Bad Request");
    assertThat(pd.getDetail()).isEqualTo("slug must not be blank");
  }

  @Test
  public void illegalArgumentWithNoMessage_fallsBackRatherThanSendingNull() {
    ProblemDetail pd = handler.handleBadRequest(new IllegalArgumentException(), request);

    assertThat(pd.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST.value());
    assertThat(pd.getDetail()).isEqualTo("Bad Request");
  }

  @Test
  public void nullPointer_isAServerError_notTheClientsFault() {
    ProblemDetail pd =
        handler.handleNullPointer(
            new NullPointerException("Cannot invoke \"Chapter.getId()\" because it is null"),
            request);

    assertThat(pd.getStatus()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR.value());
    assertThat(pd.getTitle()).isEqualTo("Internal Server Error");
  }

  @Test
  public void nullPointer_doesNotLeakOurInternalsToTheClient() {
    ProblemDetail pd =
        handler.handleNullPointer(
            new NullPointerException("Cannot invoke \"Chapter.getId()\" because it is null"),
            request);

    assertThat(pd.getDetail()).isEqualTo("An unexpected internal error occurred");
    assertThat(pd.getDetail()).doesNotContain("Chapter.getId");
  }

  @Test
  public void theTwoAreHandledSeparately() throws NoSuchMethodException {
    // The regression to guard against is the two being folded back into one @ExceptionHandler.
    assertThat(
            GlobalExceptionHandler.class
                .getMethod("handleBadRequest", IllegalArgumentException.class, WebRequest.class))
        .isNotNull();
    assertThat(
            GlobalExceptionHandler.class
                .getMethod("handleNullPointer", NullPointerException.class, WebRequest.class))
        .isNotNull();
  }
}
