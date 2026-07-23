package com.manga.library.controller;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.manga.library.config.JwtAuthFilter;
import com.manga.library.model.User;
import com.manga.library.repository.UserRepository;
import com.manga.library.service.SseService;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@WebMvcTest(NotificationController.class)
@AutoConfigureMockMvc(addFilters = false)
public class NotificationControllerTest {

  @Autowired private MockMvc mockMvc;

  @MockBean private SseService sseService;
  @MockBean private UserRepository userRepository;
  @MockBean private JwtAuthFilter jwtAuthFilter;

  @Test
  public void testStream_Unauthorized() throws Exception {
    org.springframework.security.core.context.SecurityContextHolder.clearContext();
    mockMvc.perform(get("/api/notifications/stream"))
        .andExpect(status().isInternalServerError())
        .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath("$.message")
            .value("Something went wrong: Unauthorized"));
  }

  @Test
  public void testStream_Authorized() throws Exception {
    User user = User.builder().id(UUID.randomUUID()).email("test@test.com").build();
    when(sseService.subscribe(user.getId())).thenReturn(new SseEmitter());

    org.springframework.security.core.Authentication auth =
        mock(org.springframework.security.core.Authentication.class);
    when(auth.isAuthenticated()).thenReturn(true);
    when(auth.getPrincipal()).thenReturn(user);
    org.springframework.security.core.context.SecurityContextHolder.getContext()
        .setAuthentication(auth);

    try {
      mockMvc.perform(get("/api/notifications/stream")).andExpect(status().isOk());
    } finally {
      org.springframework.security.core.context.SecurityContextHolder.clearContext();
    }
  }

  @Test
  public void testStream_UserNotFound() throws Exception {
    org.springframework.security.core.Authentication auth =
        mock(org.springframework.security.core.Authentication.class);
    when(auth.isAuthenticated()).thenReturn(true);
    when(auth.getPrincipal()).thenReturn("not-a-user-object");
    org.springframework.security.core.context.SecurityContextHolder.getContext()
        .setAuthentication(auth);

    try {
      mockMvc.perform(get("/api/notifications/stream"))
          .andExpect(status().isInternalServerError())
          .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath("$.message")
              .value("Something went wrong: User not found"));
    } finally {
      org.springframework.security.core.context.SecurityContextHolder.clearContext();
    }
  }
}
