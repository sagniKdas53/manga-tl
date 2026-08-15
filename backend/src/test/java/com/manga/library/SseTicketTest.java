package com.manga.library;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.config.JwtUtils;
import com.manga.library.config.SseTicketAuthFilter;
import com.manga.library.model.User;
import com.manga.library.repository.UserRepository;
import com.manga.library.service.SseTicketService;
import java.time.Duration;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
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
  @Autowired private SseTicketAuthFilter sseTicketAuthFilter;
  @Autowired private org.springframework.data.redis.core.StringRedisTemplate redisTemplate;

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
    String ticket = sseTicketService.issue(userId, null);

    assertEquals(
        Optional.of(userId),
        sseTicketService.redeem(ticket).map(SseTicketService.Ticket::userId));
    // Single use: a ticket recovered from a log after the connection opened is already spent.
    assertEquals(Optional.empty(), sseTicketService.redeem(ticket));
  }

  @Test
  void ticketCarriesTheSessionExpiryToTheStream() {
    // Millisecond precision is all the stored form keeps, and all the push needs.
    java.time.Instant expiry = java.time.Instant.now().plusSeconds(3600).truncatedTo(ChronoUnit.MILLIS);

    Optional<SseTicketService.Ticket> redeemed =
        sseTicketService.redeem(sseTicketService.issue(userId, expiry));

    // The stream request carries nothing but the ticket, so if the expiry does not survive this
    // round trip there is nothing left to arm the session-expired push against (AUDIT-F7).
    assertEquals(Optional.of(userId), redeemed.map(SseTicketService.Ticket::userId));
    assertEquals(Optional.of(expiry), redeemed.map(SseTicketService.Ticket::sessionExpiresAt));
  }

  @Test
  void issuedTicketCarriesTheExpiryOfThePresentedJwt() throws Exception {
    String token = jwtUtils.generateToken(EMAIL);
    MvcResult result =
        mockMvc
            .perform(post("/api/notifications/ticket").header("Authorization", "Bearer " + token))
            .andExpect(status().isOk())
            .andReturn();
    String ticket =
        objectMapper.readTree(result.getResponse().getContentAsString()).get("ticket").asText();

    Optional<SseTicketService.Ticket> redeemed = sseTicketService.redeem(ticket);

    // The POST is the only point in the handshake where the JWT is visible. If the controller
    // stops reading exp off it, the push silently never arms and nothing else fails.
    assertEquals(
        Optional.of(jwtUtils.getExpiryFromToken(token).truncatedTo(ChronoUnit.MILLIS)),
        redeemed.map(SseTicketService.Ticket::sessionExpiresAt));
  }

  @Test
  void ticketStoredWithoutAnExpiryStillRedeems() {
    // The shape this key had before AUDIT-F7. Tickets minted by the outgoing instance stay
    // redeemable for a minute after a deploy, and they must connect -- just without the push.
    String ticket = "legacy-shaped-ticket";
    redisTemplate.opsForValue().set("sse:ticket:" + ticket, userId.toString(), Duration.ofSeconds(60));

    Optional<SseTicketService.Ticket> redeemed = sseTicketService.redeem(ticket);

    assertEquals(Optional.of(userId), redeemed.map(SseTicketService.Ticket::userId));
    assertTrue(redeemed.isPresent() && redeemed.get().sessionExpiresAt() == null);
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

  /**
   * The async dispatch that ends a stream must not be denied.
   *
   * <p>Tomcat re-dispatches the request when the emitter completes — on the 1-hour timeout, or as
   * soon as the client goes away — and the auth filters run again. Nothing re-authenticated it: an
   * {@code EventSource} cannot send a header, and the ticket was spent on the initial dispatch. So
   * every disconnect was denied, which put {@code "GET /api/notifications/stream" 500} in the access
   * log and ~120 frames of stack trace at ERROR beside it, once per disconnect, for a stream that
   * had done nothing wrong.
   */
  @Test
  void streamStaysAuthenticatedAcrossTheAsyncDispatchThatEndsIt() throws Exception {
    SecurityContextHolder.clearContext();
    String ticket = sseTicketService.issue(userId, null);

    MockHttpServletRequest request =
        new MockHttpServletRequest("GET", "/api/notifications/stream");
    request.setServletPath("/api/notifications/stream");
    request.setParameter("ticket", ticket);
    MockHttpServletResponse response = new MockHttpServletResponse();

    sseTicketAuthFilter.doFilter(request, response, new MockFilterChain());
    assertTrue(
        SecurityContextHolder.getContext().getAuthentication() != null,
        "the ticket should authenticate the initial dispatch");

    // What the async dispatch actually finds an hour later: a fresh container thread with an empty
    // holder, and a ticket that redeem() consumed when the connection opened.
    SecurityContextHolder.clearContext();
    assertEquals(Optional.empty(), sseTicketService.redeem(ticket));

    request.setDispatcherType(jakarta.servlet.DispatcherType.ASYNC);
    sseTicketAuthFilter.doFilter(request, response, new MockFilterChain());

    Authentication restored = SecurityContextHolder.getContext().getAuthentication();
    assertTrue(restored != null, "async dispatch must not be denied — this is what logged the 500");
    assertEquals(userId, ((User) restored.getPrincipal()).getId());
    SecurityContextHolder.clearContext();
  }

  /**
   * The restore is keyed on an attribute only the ticket path sets, so an async dispatch it never
   * touched is left exactly as it was — those requests still re-authenticate from their header.
   */
  @Test
  void asyncDispatchOfANonSseRequestIsNotAuthenticatedByThisFilter() throws Exception {
    SecurityContextHolder.clearContext();
    MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/series");
    request.setServletPath("/api/series");
    request.setDispatcherType(jakarta.servlet.DispatcherType.ASYNC);

    sseTicketAuthFilter.doFilter(request, new MockHttpServletResponse(), new MockFilterChain());

    assertTrue(SecurityContextHolder.getContext().getAuthentication() == null);
  }
}
