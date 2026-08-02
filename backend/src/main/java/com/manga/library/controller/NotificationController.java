package com.manga.library.controller;

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

  public NotificationController(SseService sseService, SseTicketService sseTicketService) {
    this.sseService = sseService;
    this.sseTicketService = sseTicketService;
  }

  /**
   * Exchanges the session JWT — sent as a normal {@code Authorization} header on this ordinary POST
   * — for a single-use ticket the browser can safely put in the {@code EventSource} URL (AUDIT-S4).
   */
  @PostMapping("/ticket")
  public ResponseEntity<Map<String, String>> issueTicket() {
    User user = currentUser();
    return ResponseEntity.ok(Map.of("ticket", sseTicketService.issue(user.getId())));
  }

  @GetMapping("/stream")
  public SseEmitter stream() {
    User user = currentUser();
    log.info("Client connected to SSE stream: {}", user.getEmail());
    return sseService.subscribe(user.getId());
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
