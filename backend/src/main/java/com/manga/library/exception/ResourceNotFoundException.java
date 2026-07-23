package com.manga.library.exception;

/**
 * Thrown when a requested entity does not exist. Mapped to HTTP 404 by
 * GlobalExceptionHandler.
 *
 * <p>IMPORTANT: must extend RuntimeException directly, NOT IllegalArgumentException —
 * some controllers catch IllegalArgumentException locally and convert it to 400
 * (e.g. PageController upload flow), and not-found must not be swallowed by those.
 */
public class ResourceNotFoundException extends RuntimeException {
  public ResourceNotFoundException(String message) {
    super(message);
  }
}
