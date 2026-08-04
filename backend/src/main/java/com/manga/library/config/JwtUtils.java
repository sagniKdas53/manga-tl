package com.manga.library.config;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import javax.crypto.SecretKey;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class JwtUtils {

  @Value("${jwt.secret}")
  private String jwtSecret;

  @Value("${jwt.expirationMs}")
  private int jwtExpirationMs;

  private SecretKey getSigningKey() {
    byte[] keyBytes = jwtSecret.getBytes(StandardCharsets.UTF_8);
    return Keys.hmacShaKeyFor(keyBytes);
  }

  public String generateToken(String email) {
    return Jwts.builder()
        .subject(email)
        .issuedAt(new Date())
        .expiration(new Date(new Date().getTime() + jwtExpirationMs))
        .signWith(getSigningKey())
        .compact();
  }

  public String getEmailFromToken(String token) {
    Claims claims =
        Jwts.parser().verifyWith(getSigningKey()).build().parseSignedClaims(token).getPayload();
    return claims.getSubject();
  }

  /**
   * The token's {@code exp} claim, or null when it carries none or cannot be parsed.
   *
   * <p>Used to arm the SSE {@code session-expired} push (AUDIT-F7). Returning null rather than
   * throwing is deliberate: a session whose expiry cannot be read still authenticates normally, it
   * just does not get the courtesy push.
   */
  public Instant getExpiryFromToken(String token) {
    try {
      Date expiration =
          Jwts.parser()
              .verifyWith(getSigningKey())
              .build()
              .parseSignedClaims(token)
              .getPayload()
              .getExpiration();
      return expiration == null ? null : expiration.toInstant();
    } catch (Exception e) {
      return null;
    }
  }

  public boolean validateToken(String token) {
    try {
      Jwts.parser().verifyWith(getSigningKey()).build().parseSignedClaims(token);
      return true;
    } catch (Exception e) {
      return false;
    }
  }
}
