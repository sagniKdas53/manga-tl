package com.manga.library.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Objects;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class InternalAuthFilter extends OncePerRequestFilter {

  // No fallback: an unset token must fail startup in SecretsStartupValidator rather than leave
  // /api/internal/** guarded by a value that is published in this repository's history (AUDIT-S2).
  @Value("${internal.api-token:}")
  private String internalApiToken;

  @Override
  protected void doFilterInternal(
      @NonNull HttpServletRequest request,
      @NonNull HttpServletResponse response,
      @NonNull FilterChain filterChain)
      throws ServletException, IOException {
    Objects.requireNonNull(request, "request cannot be null");
    Objects.requireNonNull(response, "response cannot be null");
    Objects.requireNonNull(filterChain, "filterChain cannot be null");
    String path = request.getServletPath();
    if (path != null && path.startsWith("/api/internal")) {
      String token = request.getHeader("X-Internal-Token");
      if (!matchesConfiguredToken(token)) {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json");
        response.getWriter().write("{\"error\": \"Unauthorized: Invalid internal token\"}");
        return;
      }
    }
    filterChain.doFilter(request, response);
  }

  /**
   * Constant-time comparison against the configured token. {@code String.equals} short-circuits on
   * the first differing byte, which leaks the length of the matching prefix to anyone able to time
   * the response — enough to recover a shared secret byte by byte.
   *
   * <p>An unconfigured token never matches: absence of a credential must deny, not permit.
   */
  private boolean matchesConfiguredToken(String token) {
    if (token == null || internalApiToken == null || internalApiToken.isEmpty()) {
      return false;
    }
    return MessageDigest.isEqual(
        token.getBytes(StandardCharsets.UTF_8), internalApiToken.getBytes(StandardCharsets.UTF_8));
  }
}
