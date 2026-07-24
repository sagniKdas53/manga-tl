package com.manga.library.config;

import com.manga.library.exception.ResourceNotFoundException;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import org.springframework.lang.NonNull;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
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

  /** Validation failures (incl. Objects.requireNonNull NPEs) → 400. */
  @ExceptionHandler({IllegalArgumentException.class, NullPointerException.class})
  public ProblemDetail handleBadRequest(RuntimeException ex, WebRequest request) {
    ProblemDetail pd =
        ProblemDetail.forStatusAndDetail(
            HttpStatus.BAD_REQUEST, ex.getMessage() != null ? ex.getMessage() : "Bad Request");
    pd.setTitle("Bad Request");
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

  /** Everything else → 500, but with the actual message attached. */
  @ExceptionHandler(Exception.class)
  public ProblemDetail handleInternalError(Exception ex, WebRequest request) {
    log.error("Unhandled exception", ex);
    ProblemDetail pd =
        ProblemDetail.forStatusAndDetail(
            HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong: " + ex.getMessage());
    pd.setTitle("Internal Server Error");
    pd.setProperty("timestamp", Instant.now().toString());
    return pd;
  }
}
