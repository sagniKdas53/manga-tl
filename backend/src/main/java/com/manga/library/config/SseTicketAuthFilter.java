package com.manga.library.config;

import com.manga.library.model.User;
import com.manga.library.repository.UserRepository;
import com.manga.library.service.SseTicketService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Collections;
import java.util.Optional;
import java.util.UUID;
import org.springframework.lang.NonNull;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Authenticates the SSE stream from a {@code ticket} query parameter (AUDIT-S4).
 *
 * <p>Scoped deliberately narrowly: only {@link #SSE_STREAM_PATH}, and only for a ticket, never a
 * JWT. That scoping is the point — {@link JwtAuthFilter} no longer accepts credentials from the
 * query string at all, so the one endpoint that genuinely cannot send a header is the one endpoint
 * where a URL-borne credential exists, and that credential is single-use and expires in a minute.
 */
@Component
public class SseTicketAuthFilter extends OncePerRequestFilter {

  static final String SSE_STREAM_PATH = "/api/notifications/stream";
  static final String TICKET_PARAM = "ticket";

  private final SseTicketService sseTicketService;
  private final UserRepository userRepository;

  public SseTicketAuthFilter(SseTicketService sseTicketService, UserRepository userRepository) {
    this.sseTicketService = sseTicketService;
    this.userRepository = userRepository;
  }

  @Override
  protected void doFilterInternal(
      @NonNull HttpServletRequest request,
      @NonNull HttpServletResponse response,
      @NonNull FilterChain filterChain)
      throws ServletException, IOException {
    String ticket = request.getParameter(TICKET_PARAM);
    if (StringUtils.hasText(ticket)
        && isSseStreamRequest(request)
        && SecurityContextHolder.getContext().getAuthentication() == null) {
      authenticateFromTicket(request, ticket);
    }
    filterChain.doFilter(request, response);
  }

  /**
   * The servlet path is the authoritative answer under a real container, where the {@code
   * CONTEXT_PATH} prefix has already been stripped. It is empty under MockMvc, so fall back to
   * matching the tail of the request URI — which also covers the deployed prefix directly.
   */
  private boolean isSseStreamRequest(HttpServletRequest request) {
    if (SSE_STREAM_PATH.equals(request.getServletPath())) {
      return true;
    }
    String uri = request.getRequestURI();
    return uri != null && uri.endsWith(SSE_STREAM_PATH);
  }

  private void authenticateFromTicket(HttpServletRequest request, String ticket) {
    try {
      Optional<UUID> userId = sseTicketService.redeem(ticket);
      if (userId.isEmpty()) {
        return;
      }
      User user = userRepository.findById(userId.get()).orElse(null);
      if (user == null) {
        return;
      }
      String roleStr = user.getRole() != null ? user.getRole().toUpperCase() : "VIEWER";
      UsernamePasswordAuthenticationToken authentication =
          new UsernamePasswordAuthenticationToken(
              user, null, Collections.singletonList(new SimpleGrantedAuthority("ROLE_" + roleStr)));
      authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
      SecurityContextHolder.getContext().setAuthentication(authentication);
    } catch (RuntimeException e) {
      logger.error("Failed to authenticate SSE ticket", e);
    }
  }

  @Override
  protected boolean shouldNotFilterAsyncDispatch() {
    return false;
  }
}
