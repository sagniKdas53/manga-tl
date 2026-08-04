package com.manga.library.controller;

import com.manga.library.config.JwtUtils;
import com.manga.library.config.SseTicketAuthFilter;
import com.manga.library.model.User;
import com.manga.library.service.SseService;
import com.manga.library.service.SseTicketService;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequestMapping("/api/notifications")
public class NotificationController {
  private static final org.slf4j.Logger log =
      org.slf4j.LoggerFactory.getLogger(NotificationController.class);

  private final SseService sseService;
  private final SseTicketService sseTicketService;
  private final JwtUtils jwtUtils;

  public NotificationController(
      SseService sseService, SseTicketService sseTicketService, JwtUtils jwtUtils) {
    this.sseService = sseService;
    this.sseTicketService = sseTicketService;
    this.jwtUtils = jwtUtils;
  }

  /**
   * Exchanges the session JWT — sent as a normal {@code Authorization} header on this ordinary POST
   * — for a single-use ticket the browser can safely put in the {@code EventSource} URL (AUDIT-S4).
   *
   * <p>This is the only point in the SSE handshake where the JWT is visible, so it is also where
   * the session's expiry has to be read off it for AUDIT-F7. The filter has already validated the
   * header by the time this runs; re-parsing it here just to read {@code exp} keeps the change out
   * of the authentication path.
   */
  @PostMapping("/ticket")
  public ResponseEntity<Map<String, String>> issueTicket(
      jakarta.servlet.http.HttpServletRequest request) {
    User user = currentUser();
    return ResponseEntity.ok(
        Map.of("ticket", sseTicketService.issue(user.getId(), sessionExpiry(request))));
  }

  /**
   * Read off the raw request rather than bound with {@code @RequestHeader} on purpose: the header
   * is already required of every authenticated call, and declaring it here would publish it as a
   * parameter of this one endpoint in the OpenAPI spec and churn the generated frontend types.
   */
  private java.time.Instant sessionExpiry(jakarta.servlet.http.HttpServletRequest request) {
    String authorization = request.getHeader("Authorization");
    if (authorization == null || !authorization.startsWith("Bearer ")) {
      return null;
    }
    return jwtUtils.getExpiryFromToken(authorization.substring(7));
  }

  @GetMapping("/stream")
  public SseEmitter stream(jakarta.servlet.http.HttpServletRequest request) {
    User user = currentUser();
    log.info("Client connected to SSE stream: {}", user.getEmail());
    Object expiresAt = request.getAttribute(SseTicketAuthFilter.SESSION_EXPIRES_AT_ATTRIBUTE);
    return sseService.subscribe(
        user.getId(), expiresAt instanceof java.time.Instant at ? at : null);
  }

  private User currentUser() {
    Authentication auth = SecurityContextHolder.getContext().getAuthentication();
    if (auth == null || !auth.isAuthenticated()) {
      throw new RuntimeException("Unauthorized");
    }

    Object principal = auth.getPrincipal();
    if (!(principal instanceof User)) {
      throw new RuntimeException("User not found");
    }
    return (User) principal;
  }
}
