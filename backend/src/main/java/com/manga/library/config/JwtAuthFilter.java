package com.manga.library.config;

import com.manga.library.model.User;
import com.manga.library.repository.UserRepository;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Collections;
import java.util.Objects;
import org.springframework.lang.NonNull;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class JwtAuthFilter extends OncePerRequestFilter {

  /**
   * AUDIT-B8. The inherited {@code logger} from {@link org.springframework.web.filter.GenericFilterBean}
   * is a commons-logging {@code Log}, which has no {@code (String, Object...)} overload and does not
   * interpolate — {@code logger.error("…: {}", e)} bound to {@code error(Object, Throwable)}, so the
   * throwable was attached correctly but the {@code {}} printed literally. (The issue was filed the
   * other way round, as a lost stack trace.) An SLF4J logger of our own removes the ambiguity: this
   * class now says which overload it means.
   */
  private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(JwtAuthFilter.class);

  private final JwtUtils jwtUtils;
  private final UserRepository userRepository;

  public JwtAuthFilter(JwtUtils jwtUtils, UserRepository userRepository) {
    this.jwtUtils = jwtUtils;
    this.userRepository = userRepository;
  }

  @Override
  protected void doFilterInternal(
      @NonNull HttpServletRequest request,
      @NonNull HttpServletResponse response,
      @NonNull FilterChain filterChain)
      throws ServletException, IOException {
    Objects.requireNonNull(request, "request cannot be null");
    Objects.requireNonNull(response, "response cannot be null");
    Objects.requireNonNull(filterChain, "filterChain cannot be null");
    try {
      String jwt = parseJwt(request);
      if (jwt != null && jwtUtils.validateToken(jwt)) {
        String email = jwtUtils.getEmailFromToken(jwt);
        User user = userRepository.findByEmail(email).orElse(null);
        if (user != null) {
          String roleStr = user.getRole() != null ? user.getRole().toUpperCase() : "VIEWER";
          UsernamePasswordAuthenticationToken authentication =
              new UsernamePasswordAuthenticationToken(
                  user,
                  null,
                  Collections.singletonList(new SimpleGrantedAuthority("ROLE_" + roleStr)));
          authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
          SecurityContextHolder.getContext().setAuthentication(authentication);
        }
      }
    } catch (Exception e) {
      log.error("Cannot set user authentication", e);
    }

    filterChain.doFilter(request, response);
  }

  @Override
  protected boolean shouldNotFilterAsyncDispatch() {
    return false;
  }

  /**
   * Header only. A {@code ?token=} fallback used to exist for {@code EventSource}, which cannot set
   * headers — but Tomcat's access log recorded the full request line, so every SSE connection wrote
   * a 24-hour bearer token into the log in plaintext (AUDIT-S4). SSE now authenticates with a
   * single-use ticket via {@link SseTicketAuthFilter} instead.
   */
  private String parseJwt(HttpServletRequest request) {
    String headerAuth = request.getHeader("Authorization");
    if (StringUtils.hasText(headerAuth) && headerAuth.startsWith("Bearer ")) {
      return headerAuth.substring(7);
    }
    return null;
  }
}
