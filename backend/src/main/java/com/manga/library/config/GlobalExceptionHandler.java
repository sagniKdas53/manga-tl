package com.manga.library.config;

import com.manga.library.exception.ResourceNotFoundException;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.lang.NonNull;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

/** Maps exceptions to proper HTTP status codes using RFC 7807 Problem Details. */
@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

  /** Entity not found → 404. */
  @ExceptionHandler(ResourceNotFoundException.class)
  public ProblemDetail handleNotFound(ResourceNotFoundException ex, WebRequest request) {
    ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
    pd.setTitle("Not Found");
    pd.setProperty("timestamp", Instant.now().toString());
    return pd;
  }

  /** Validation failures → 400. */
  @ExceptionHandler(IllegalArgumentException.class)
  public ProblemDetail handleBadRequest(IllegalArgumentException ex, WebRequest request) {
    ProblemDetail pd =
        ProblemDetail.forStatusAndDetail(
            HttpStatus.BAD_REQUEST, ex.getMessage() != null ? ex.getMessage() : "Bad Request");
    pd.setTitle("Bad Request");
    pd.setProperty("timestamp", Instant.now().toString());
    return pd;
  }

  /**
   * A NullPointerException is a server bug → 500, and logged (AUDIT-B3).
   *
   * <p>This used to share the 400 handler above, on the reasoning that {@code
   * Objects.requireNonNull} throws NPE and is used for argument validation. The cost was that every
   * genuine NPE anywhere in a controller path was reported to the client as their bad request, with
   * no stack trace written anywhere — the most common kind of server bug became the one least likely
   * to be noticed.
   *
   * <p>A null check that is really input validation belongs in {@code IllegalArgumentException}. The
   * detail sent to the client is deliberately generic: an NPE message describes our internals.
   */
  @ExceptionHandler(NullPointerException.class)
  public ProblemDetail handleNullPointer(NullPointerException ex, WebRequest request) {
    log.error("Unhandled NullPointerException while handling {}", request.getDescription(false), ex);
    ProblemDetail pd =
        ProblemDetail.forStatusAndDetail(
            HttpStatus.INTERNAL_SERVER_ERROR, "An unexpected internal error occurred");
    pd.setTitle("Internal Server Error");
    pd.setProperty("timestamp", Instant.now().toString());
    return pd;
  }

  /** Upload too large → 413. */
  @Override
  protected ResponseEntity<Object> handleMaxUploadSizeExceededException(
      @NonNull MaxUploadSizeExceededException ex,
      @NonNull HttpHeaders headers,
      @NonNull HttpStatusCode status,
      @NonNull WebRequest request) {
    ProblemDetail pd =
        ProblemDetail.forStatusAndDetail(
            HttpStatus.PAYLOAD_TOO_LARGE, "File exceeds maximum upload size");
    pd.setTitle("Payload Too Large");
    pd.setProperty("timestamp", Instant.now().toString());
    return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).body(pd);
  }

  /** Validation failures on @RequestBody (MethodArgumentNotValidException) → 400. */
  @Override
  protected ResponseEntity<Object> handleMethodArgumentNotValid(
      @NonNull MethodArgumentNotValidException ex,
      @NonNull HttpHeaders headers,
      @NonNull HttpStatusCode status,
      @NonNull WebRequest request) {

    ProblemDetail pd = ProblemDetail.forStatusAndDetail(status, "Validation failed for request");
    pd.setTitle("Validation Failed");
    pd.setProperty("timestamp", Instant.now().toString());

    Map<String, String> errors = new HashMap<>();
    for (FieldError error : ex.getBindingResult().getFieldErrors()) {
      errors.put(error.getField(), error.getDefaultMessage());
    }
    pd.setProperty("errors", errors);

    return ResponseEntity.status(status).body(pd);
  }

  /**
   * A denied {@code @PreAuthorize} → 403 (AUDIT-B3).
   *
   * <p>Without this the denial fell through to the catch-all below and came back as a 500, so
   * {@link com.manga.library.controller.LayerController}'s eight editor-only endpoints told a
   * viewer the server was broken rather than that they lacked the role. A 500 is also the one
   * status a client is entitled to retry.
   *
   * <p>This advice runs inside the dispatcher and therefore before Spring Security's {@code
   * ExceptionTranslationFilter} ever sees the exception, which is why the filter's own handling
   * never applied. Requests with no authentication at all are rejected by the filter chain long
   * before a controller method, so reaching here means authenticated-but-insufficient: 403, not
   * 401.
   */
  @ExceptionHandler(org.springframework.security.access.AccessDeniedException.class)
  public ProblemDetail handleAccessDenied(
      org.springframework.security.access.AccessDeniedException ex, WebRequest request) {
    ProblemDetail pd =
        ProblemDetail.forStatusAndDetail(
            HttpStatus.FORBIDDEN, "You do not have permission to perform this action");
    pd.setTitle("Forbidden");
    pd.setProperty("timestamp", Instant.now().toString());
    return pd;
  }

  /**
   * Everything else → 500, with the cause logged and a generic detail sent (AUDIT-B3).
   *
   * <p>This used to return {@code "Something went wrong: " + ex.getMessage()} to the client. An
   * arbitrary exception's message is written for an operator, not a user: constraint violations
   * carry SQL and column names, IO failures carry absolute paths, and anything wrapping a driver
   * error carries internal identifiers. Same shape as {@link #handleNullPointer} above — the
   * message goes to the log, where it is useful and not readable by the caller.
   */
  @ExceptionHandler(Exception.class)
  public ProblemDetail handleInternalError(Exception ex, WebRequest request) {
    log.error("Unhandled exception while handling {}", request.getDescription(false), ex);
    ProblemDetail pd =
        ProblemDetail.forStatusAndDetail(
            HttpStatus.INTERNAL_SERVER_ERROR, "An unexpected internal error occurred");
    pd.setTitle("Internal Server Error");
    pd.setProperty("timestamp", Instant.now().toString());
    return pd;
  }
}
