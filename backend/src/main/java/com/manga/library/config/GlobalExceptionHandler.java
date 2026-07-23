package com.manga.library.config;

import com.manga.library.exception.ResourceNotFoundException;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.multipart.MaxUploadSizeExceededException;

/**
 * Maps exceptions to proper HTTP status codes with human-readable messages.
 * Response shape: {timestamp, status, error, message, path}.
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

  private ResponseEntity<Map<String, Object>> buildBody(
      HttpStatus status, String message, HttpServletRequest request) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("timestamp", Instant.now().toString());
    body.put("status", status.value());
    body.put("error", status.getReasonPhrase());
    body.put("message", message == null ? status.getReasonPhrase() : message);
    body.put("path", request.getRequestURI());
    return ResponseEntity.status(status).body(body);
  }

  /** Entity not found → 404. */
  @ExceptionHandler(ResourceNotFoundException.class)
  public ResponseEntity<Map<String, Object>> handleNotFound(
      ResourceNotFoundException ex, HttpServletRequest request) {
    return buildBody(HttpStatus.NOT_FOUND, ex.getMessage(), request);
  }

  /** Validation failures (incl. Objects.requireNonNull NPEs) → 400. */
  @ExceptionHandler({IllegalArgumentException.class, NullPointerException.class})
  public ResponseEntity<Map<String, Object>> handleBadRequest(
      RuntimeException ex, HttpServletRequest request) {
    return buildBody(HttpStatus.BAD_REQUEST, ex.getMessage(), request);
  }

  /** Upload too large → 413. */
  @ExceptionHandler(MaxUploadSizeExceededException.class)
  public ResponseEntity<Map<String, Object>> handleUploadTooLarge(
      MaxUploadSizeExceededException ex, HttpServletRequest request) {
    return buildBody(HttpStatus.PAYLOAD_TOO_LARGE, "File exceeds maximum upload size", request);
  }

  /** Everything else → 500, but with the actual message attached. */
  @ExceptionHandler(Exception.class)
  public ResponseEntity<Map<String, Object>> handleInternalError(
      Exception ex, HttpServletRequest request) {
    log.error("Unhandled exception on {} {}", request.getMethod(), request.getRequestURI(), ex);
    return buildBody(
        HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong: " + ex.getMessage(), request);
  }
}
