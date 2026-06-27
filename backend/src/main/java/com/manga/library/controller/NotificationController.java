package com.manga.library.controller;

import com.manga.library.model.User;
import com.manga.library.repository.UserRepository;
import com.manga.library.service.SseService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequestMapping("/api/notifications")
@RequiredArgsConstructor
@Slf4j
public class NotificationController {

  private final SseService sseService;
  private final UserRepository userRepository;

  @GetMapping("/stream")
  public SseEmitter stream() {
    Authentication auth = SecurityContextHolder.getContext().getAuthentication();
    if (auth == null || !auth.isAuthenticated()) {
      throw new RuntimeException("Unauthorized");
    }

    Object principal = auth.getPrincipal();
    if (!(principal instanceof User)) {
      throw new RuntimeException("User not found");
    }

    User user = (User) principal;
    log.info("Client connected to SSE stream: {}", user.getEmail());
    return sseService.subscribe(user.getId());
  }
}
