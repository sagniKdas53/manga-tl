package com.manga.library.config;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Instant;
import java.util.Date;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

/** AUDIT-B8. */
public class JwtUtilsTest {

  private static final String SECRET = "a-test-signing-key-long-enough-for-hmac-sha-256-abcdefgh";

  private JwtUtils utilsWithExpiry(long expirationMs) {
    JwtUtils utils = new JwtUtils();
    ReflectionTestUtils.setField(utils, "jwtSecret", SECRET);
    ReflectionTestUtils.setField(utils, "jwtExpirationMs", expirationMs);
    return utils;
  }

  /**
   * {@code jwtExpirationMs} was an {@code int}, so anything past {@code Integer.MAX_VALUE} ms
   * (~24.8 days) wrapped negative — and {@code new Date(now + jwtExpirationMs)} then put the expiry
   * in the *past*, minting tokens that were born expired. 30 days is the first round configuration
   * value past the boundary and the one someone would plausibly set.
   */
  @Test
  public void testGenerateToken_A30DayExpiryLandsInTheFuture() {
    long thirtyDays = 30L * 24 * 60 * 60 * 1000; // 2,592,000,000 — over Integer.MAX_VALUE
    assertTrue(thirtyDays > Integer.MAX_VALUE, "the fixture must actually cross the int boundary");

    JwtUtils utils = utilsWithExpiry(thirtyDays);
    Date before = new Date();
    Instant expiry = utils.getExpiryFromToken(utils.generateToken("someone@example.com"));

    // With the int field this is null rather than a past Instant: the overflow puts exp so far
    // back that the token is already expired, and parsing it throws before any claim is returned.
    assertNotNull(
        expiry, "no exp claim came back — the token was minted already expired (int overflow)");
    assertTrue(
        expiry.isAfter(before.toInstant()),
        "expiry " + expiry + " is not after " + before + " — the millisecond value overflowed");
  }

  /** The ordinary configured value (24 h) is unchanged by the widening. */
  @Test
  public void testGenerateToken_TheConfiguredDayLongExpiryStillWorks() {
    long oneDay = 86_400_000L;
    JwtUtils utils = utilsWithExpiry(oneDay);
    Date now = new Date();
    Instant expiry = utils.getExpiryFromToken(utils.generateToken("someone@example.com"));

    assertNotNull(expiry);
    long delta = expiry.toEpochMilli() - now.getTime();
    assertTrue(
        Math.abs(delta - oneDay) < 5_000, "expiry was " + delta + " ms out, expected ~" + oneDay);
  }
}
