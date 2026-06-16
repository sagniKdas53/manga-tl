package com.manga.library.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class InternalAuthFilter extends OncePerRequestFilter {

  @Value("${internal.api-token:manga-library-internal-token-12345}")
  private String internalApiToken;

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
      throws ServletException, IOException {
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
