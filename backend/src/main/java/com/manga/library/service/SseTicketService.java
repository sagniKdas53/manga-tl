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

  /**
   * What a redeemed ticket was issued against.
   *
   * @param userId the user the ticket authenticates
   * @param sessionExpiresAt when the JWT that bought the ticket expires, or null when the token
   *     carried no readable {@code exp}. The stream arms its {@code session-expired} push against
   *     this (AUDIT-F7); a null simply means no push is armed.
   */
  public record Ticket(UUID userId, java.time.Instant sessionExpiresAt) {}

  /**
   * Mints a ticket for {@code userId}, valid for {@link #TICKET_TTL} and for one connection.
   *
   * <p>{@code sessionExpiresAt} rides along because the stream request cannot recover it: the JWT
   * is presented on this POST and never again, and the {@code EventSource} that follows carries
   * nothing but the ticket.
   */
  public String issue(UUID userId, java.time.Instant sessionExpiresAt) {
    byte[] bytes = new byte[TICKET_BYTES];
    random.nextBytes(bytes);
    String ticket = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    String value =
        sessionExpiresAt == null
            ? userId.toString()
            : userId + FIELD_SEPARATOR + sessionExpiresAt.toEpochMilli();
    redisTemplate.opsForValue().set(TICKET_PREFIX + ticket, value, TICKET_TTL);
    return ticket;
  }

  /** Separates the user id from the session expiry in the stored value. */
  private static final String FIELD_SEPARATOR = "|";

  /**
   * Redeems a ticket, returning the user it was issued to and that session's expiry.
   *
   * <p>The delete is what makes the ticket single-use: a ticket captured from a log or a referrer
   * header after the connection opened is already spent.
   *
   * <p>A value with no separator is read as a user id with no expiry. That is the shape this key
   * had before AUDIT-F7, and tickets minted by the outgoing instance are still redeemable for a
   * minute after a deploy — they should connect, just without the push.
   */
  public Optional<Ticket> redeem(String ticket) {
    if (ticket == null || ticket.isBlank()) {
      return Optional.empty();
    }
    String stored = redisTemplate.opsForValue().getAndDelete(TICKET_PREFIX + ticket);
    if (stored == null) {
      return Optional.empty();
    }
    int separator = stored.indexOf(FIELD_SEPARATOR);
    String userId = separator < 0 ? stored : stored.substring(0, separator);
    try {
      return Optional.of(new Ticket(UUID.fromString(userId), parseExpiry(stored, separator)));
    } catch (IllegalArgumentException e) {
      return Optional.empty();
    }
  }

  private static java.time.Instant parseExpiry(String stored, int separator) {
    if (separator < 0) {
      return null;
    }
    try {
      return java.time.Instant.ofEpochMilli(Long.parseLong(stored.substring(separator + 1)));
    } catch (NumberFormatException e) {
      return null; // A malformed expiry costs the push, not the connection.
    }
  }
}
