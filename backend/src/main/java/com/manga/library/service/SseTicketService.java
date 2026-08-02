package com.manga.library.service;

import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

/**
 * Issues single-use, short-lived tickets that authenticate an SSE connection (AUDIT-S4).
 *
 * <p>{@code EventSource} cannot set request headers, so the frontend used to append the session JWT
 * to the stream URL. A query string is the worst place to put a bearer credential: Tomcat's access
 * log pattern recorded the full request line, so every reconnect wrote a token valid for 24 hours
 * into {@code catalina} in plaintext, from where it reached the Traefik log and any log shipper.
 *
 * <p>A ticket is instead worthless within a minute of being minted and dies the moment it is used,
 * so the same leak yields nothing an attacker can replay.
 */
@Service
public class SseTicketService {

  /** Long enough that guessing is hopeless inside the TTL. */
  private static final int TICKET_BYTES = 32;

  static final Duration TICKET_TTL = Duration.ofSeconds(60);

  private static final String TICKET_PREFIX = "sse:ticket:";

  private final StringRedisTemplate redisTemplate;
  private final SecureRandom random = new SecureRandom();

  public SseTicketService(StringRedisTemplate redisTemplate) {
    this.redisTemplate = redisTemplate;
  }

  /** Mints a ticket for {@code userId}, valid for {@link #TICKET_TTL} and for one connection. */
  public String issue(UUID userId) {
    byte[] bytes = new byte[TICKET_BYTES];
    random.nextBytes(bytes);
    String ticket = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    redisTemplate.opsForValue().set(TICKET_PREFIX + ticket, userId.toString(), TICKET_TTL);
    return ticket;
  }

  /**
   * Redeems a ticket, returning the user it was issued to.
   *
   * <p>The delete is what makes the ticket single-use: a ticket captured from a log or a referrer
   * header after the connection opened is already spent.
   */
  public Optional<UUID> redeem(String ticket) {
    if (ticket == null || ticket.isBlank()) {
      return Optional.empty();
    }
    String userId = redisTemplate.opsForValue().getAndDelete(TICKET_PREFIX + ticket);
    if (userId == null) {
      return Optional.empty();
    }
    try {
      return Optional.of(UUID.fromString(userId));
    } catch (IllegalArgumentException e) {
      return Optional.empty();
    }
  }
}
