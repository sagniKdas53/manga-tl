package com.manga.library.config;

import com.manga.library.model.User;
import com.manga.library.repository.UserRepository;
import com.manga.library.service.SseTicketService;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Collections;
import java.util.Optional;
import org.springframework.lang.NonNull;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
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

  /** Request attribute carrying the redeemed ticket's session expiry, as an {@link java.time.Instant}. */
  public static final String SESSION_EXPIRES_AT_ATTRIBUTE = "sse.sessionExpiresAt";

  /**
   * Request attribute carrying the {@link Authentication} this filter built when the ticket was
   * redeemed, so the async dispatch can restore it. See {@link #restoreAuthentication}.
   */
  static final String AUTHENTICATION_ATTRIBUTE = "sse.authentication";

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
    if (SecurityContextHolder.getContext().getAuthentication() == null) {
      if (request.getDispatcherType() == DispatcherType.ASYNC) {
        restoreAuthentication(request);
      } else {
        String ticket = request.getParameter(TICKET_PARAM);
        if (StringUtils.hasText(ticket) && isSseStreamRequest(request)) {
          authenticateFromTicket(request, ticket);
        }
      }
    }
    filterChain.doFilter(request, response);
  }

  /**
   * Re-establishes the {@code SecurityContext} on the async dispatch that ends an SSE stream.
   *
   * <p>Without this, every SSE disconnect was denied. Tomcat re-dispatches the request when the
   * emitter completes — on the 1-hour timeout, or as soon as the client goes away — and the auth
   * filters run again. {@link JwtAuthFilter} finds nothing, because an {@code EventSource} cannot
   * send an {@code Authorization} header; this filter found nothing either, because {@link
   * SseTicketService#redeem} is a {@code GETDEL} and the ticket was spent on the initial dispatch.
   * {@code AuthorizationFilter} then denied a request that was properly authenticated an hour
   * earlier, which is what put {@code "GET /api/notifications/stream" 500} in the access log and
   * ~120 frames of stack trace at ERROR next to it.
   *
   * <p>What is restored is the {@link Authentication} built when the ticket <em>was</em> redeemed,
   * carried on the request object the container re-dispatches. That keeps the ticket single-use —
   * this is the same request being finished, not a second one being admitted — and changes nothing
   * about how a client authenticates. Non-SSE async requests never set the attribute and are
   * unaffected; they re-authenticate from their {@code Authorization} header as before.
   *
   * <p>No expiry check here on purpose. The dispatch this serves is the request <em>ending</em>: the
   * response is committed, the emitter is already complete, and no handler runs after it. Session
   * expiry during a live stream is handled where it can still matter, by {@code SseService}'s
   * session-expired push.
   */
  private void restoreAuthentication(HttpServletRequest request) {
    if (request.getAttribute(AUTHENTICATION_ATTRIBUTE) instanceof Authentication authentication) {
      SecurityContextHolder.getContext().setAuthentication(authentication);
    }
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
      Optional<SseTicketService.Ticket> redeemed = sseTicketService.redeem(ticket);
      if (redeemed.isEmpty()) {
        return;
      }
      User user = userRepository.findById(redeemed.get().userId()).orElse(null);
      if (user == null) {
        return;
      }
      // Handed to the controller rather than acted on here: this filter's job is authentication,
      // and the emitter that the push has to be armed against does not exist yet.
      if (redeemed.get().sessionExpiresAt() != null) {
        request.setAttribute(SESSION_EXPIRES_AT_ATTRIBUTE, redeemed.get().sessionExpiresAt());
      }
      String roleStr = user.getRole() != null ? user.getRole().toUpperCase() : "VIEWER";
      UsernamePasswordAuthenticationToken authentication =
          new UsernamePasswordAuthenticationToken(
              user, null, Collections.singletonList(new SimpleGrantedAuthority("ROLE_" + roleStr)));
      authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
      SecurityContextHolder.getContext().setAuthentication(authentication);
      // Kept for the async dispatch that ends this stream, by which time the ticket is spent.
      request.setAttribute(AUTHENTICATION_ATTRIBUTE, authentication);
    } catch (RuntimeException e) {
      logger.error("Failed to authenticate SSE ticket", e);
    }
  }

  @Override
  protected boolean shouldNotFilterAsyncDispatch() {
    return false;
  }
}
