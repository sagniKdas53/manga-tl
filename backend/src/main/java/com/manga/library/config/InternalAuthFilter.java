package com.manga.library.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Objects;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@SuppressWarnings("null")
public class InternalAuthFilter extends OncePerRequestFilter {

  @Value("${internal.api-token:manga-library-internal-token-12345}")
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
      if (token == null || !token.equals(internalApiToken)) {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json");
        response.getWriter().write("{\"error\": \"Unauthorized: Invalid internal token\"}");
        return;
      }
    }
    filterChain.doFilter(request, response);
  }
}
