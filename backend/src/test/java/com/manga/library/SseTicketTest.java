package com.manga.library;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.config.JwtUtils;
import com.manga.library.model.User;
import com.manga.library.repository.UserRepository;
import com.manga.library.service.SseTicketService;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/** Covers the SSE ticket exchange that replaced the JWT-in-the-query-string flow (AUDIT-S4). */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Import(RedisTestcontainersConfig.class)
public class SseTicketTest {

  private static final String EMAIL = "sse-ticket@manga.local";

  @Autowired private MockMvc mockMvc;
  @Autowired private ObjectMapper objectMapper;
  @Autowired private JwtUtils jwtUtils;
  @Autowired private UserRepository userRepository;
  @Autowired private SseTicketService sseTicketService;

  private UUID userId;

  @BeforeEach
  void createUser() {
    User user =
        userRepository
            .findByEmail(EMAIL)
            .orElseGet(
                () -> {
                  User created = new User();
                  created.setEmail(EMAIL);
                  created.setPasswordHash("mock_password_hash");
                  created.setDisplayName("SSE User");
                  created.setRole("admin");
                  return userRepository.save(created);
                });
    userId = user.getId();
  }

  private String authHeader() {
    return "Bearer " + jwtUtils.generateToken(EMAIL);
  }

  private String requestTicket() throws Exception {
    MvcResult result =
        mockMvc
            .perform(post("/api/notifications/ticket").header("Authorization", authHeader()))
            .andExpect(status().isOk())
            .andReturn();
    return objectMapper.readTree(result.getResponse().getContentAsString()).get("ticket").asText();
  }

  @Test
  void ticketEndpointRequiresAuthentication() throws Exception {
    mockMvc.perform(post("/api/notifications/ticket")).andExpect(status().isForbidden());
  }

  @Test
  void issuesADistinctTicketPerRequest() throws Exception {
    String first = requestTicket();
    String second = requestTicket();
    assertTrue(first.length() >= 32, "ticket should not be guessable: " + first);
    assertNotEquals(first, second);
  }

  @Test
  void ticketRedeemsToTheIssuingUserExactlyOnce() {
    String ticket = sseTicketService.issue(userId);

    assertEquals(Optional.of(userId), sseTicketService.redeem(ticket));
    // Single use: a ticket recovered from a log after the connection opened is already spent.
    assertEquals(Optional.empty(), sseTicketService.redeem(ticket));
  }

  @Test
  void rejectsUnknownAndEmptyTickets() {
    assertEquals(Optional.empty(), sseTicketService.redeem(null));
    assertEquals(Optional.empty(), sseTicketService.redeem("  "));
    assertEquals(Optional.empty(), sseTicketService.redeem("not-a-real-ticket"));
  }

  @Test
  void streamAcceptsAValidTicket() throws Exception {
    String ticket = requestTicket();
    mockMvc
        .perform(get("/api/notifications/stream").param("ticket", ticket))
        .andExpect(status().isOk());
  }

  @Test
  void streamRejectsAnInvalidTicket() throws Exception {
    mockMvc
        .perform(get("/api/notifications/stream").param("ticket", "bogus-ticket"))
        .andExpect(status().isForbidden());
  }

  @Test
  void streamRejectsAReusedTicket() throws Exception {
    String ticket = requestTicket();
    mockMvc
        .perform(get("/api/notifications/stream").param("ticket", ticket))
        .andExpect(status().isOk());
    mockMvc
        .perform(get("/api/notifications/stream").param("ticket", ticket))
        .andExpect(status().isForbidden());
  }

  @Test
  void streamRejectsASessionJwtInTheQueryString() throws Exception {
    mockMvc
        .perform(get("/api/notifications/stream").param("token", jwtUtils.generateToken(EMAIL)))
        .andExpect(status().isForbidden());
  }
}
