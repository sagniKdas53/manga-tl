package com.manga.library.config;

import java.util.Arrays;
import java.util.Collections;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.config.annotation.authentication.configuration.AuthenticationConfiguration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

@Configuration
@EnableWebSecurity
@org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity
public class SecurityConfig {

  private final JwtAuthFilter jwtAuthFilter;
  private final SseTicketAuthFilter sseTicketAuthFilter;

  public SecurityConfig(JwtAuthFilter jwtAuthFilter, SseTicketAuthFilter sseTicketAuthFilter) {
    this.jwtAuthFilter = jwtAuthFilter;
    this.sseTicketAuthFilter = sseTicketAuthFilter;
  }

  /**
   * Image bytes are deliberately public; everything that decides, changes or reveals state is not.
   *
   * <p><b>Do not "fix" this by adding authentication.</b> Two image routes are open on purpose:
   *
   * <ul>
   *   <li>{@code /api/images/*&#47;thumbnail} — 512px WebP, long-standing.
   *   <li>{@code /api/images/*&#47;reader} — the downscaled WebP reading variant.
   * </ul>
   *
   * <p>Three reasons, in order of weight:
   *
   * <ol>
   *   <li><b>An {@code <img>} cannot send an {@code Authorization} header.</b> Requiring one forces
   *       the frontend to fetch bytes through JavaScript and hand them to the element as a blob URL,
   *       which costs progressive decoding, the browser's own request prioritisation, and the HTTP
   *       cache. That was tried (commit {@code 02d9185}, to repair the reader after AUDIT-S4 removed
   *       {@code ?token=}) and measurably regressed the reader — see
   *       {@code docs/reader_perf_plan_2026-08-03.md}.
   *   <li><b>Authenticated responses cannot be cached usefully.</b> A public, immutable image is
   *       cacheable by the browser and any intermediary; a per-user one is not.
   *   <li><b>It matches how comparable readers work.</b> MangaDex's API documentation instructs
   *       clients <i>not</i> to send authentication headers when fetching page images, and serves
   *       them from an unauthenticated CDN.
   * </ol>
   *
   * <p><b>What this does not open.</b> Listing, searching and metadata stay authenticated, so the
   * catalogue is not enumerable: reaching an image requires already knowing its UUID. Originals
   * ({@code /file}) stay authenticated — only the derived, downscaled, lossy variants are public.
   * Nothing here is a write path.
   *
   * <p>If the deployment ever needs the images closed too, do not simply move the matchers: replace
   * them with a short-TTL signed URL (the model {@link SseTicketAuthFilter} already uses for SSE),
   * which preserves native {@code <img>} loading. Reverting to header auth reintroduces the
   * regression above.
   */
  @Bean
  public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    http.cors(cors -> cors.configurationSource(corsConfigurationSource()))
        .csrf(csrf -> csrf.disable())
        .sessionManagement(
            session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(
            auth ->
                auth.requestMatchers("/api/auth/**")
                    .permitAll()
                    .requestMatchers("/actuator/**")
                    .permitAll()
                    .requestMatchers("/api/internal/**")
                    .permitAll()
                    // Public on purpose — read the javadoc on this method before changing.
                    .requestMatchers("/api/images/*/thumbnail", "/api/images/*/reader")
                    .permitAll()
                    .requestMatchers(org.springframework.http.HttpMethod.DELETE, "/api/layers/**")
                    .hasAnyRole("ADMIN", "TRANSLATOR")
                    .requestMatchers("/api/**")
                    .authenticated()
                    .anyRequest()
                    .permitAll())
        .addFilterBefore(sseTicketAuthFilter, UsernamePasswordAuthenticationFilter.class)
        .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class);

    return http.build();
  }

  /**
   * Both filters are {@code @Component}s, which makes Spring Boot register them in the plain
   * servlet chain as well as the security chain — so each would run twice per request. The security
   * chain is where they belong; this disables the servlet-container registration (AUDIT-B8).
   */
  @Bean
  public FilterRegistrationBean<JwtAuthFilter> jwtAuthFilterRegistration(JwtAuthFilter filter) {
    FilterRegistrationBean<JwtAuthFilter> registration = new FilterRegistrationBean<>(filter);
    registration.setEnabled(false);
    return registration;
  }

  @Bean
  public FilterRegistrationBean<SseTicketAuthFilter> sseTicketAuthFilterRegistration(
      SseTicketAuthFilter filter) {
    FilterRegistrationBean<SseTicketAuthFilter> registration = new FilterRegistrationBean<>(filter);
    registration.setEnabled(false);
    return registration;
  }

  @Bean
  public PasswordEncoder passwordEncoder() {
    return new BCryptPasswordEncoder();
  }

  @Bean
  public AuthenticationManager authenticationManager(AuthenticationConfiguration authConfig)
      throws Exception {
    return authConfig.getAuthenticationManager();
  }

  @Bean
  public CorsConfigurationSource corsConfigurationSource() {
    CorsConfiguration configuration = new CorsConfiguration();
    configuration.setAllowedOriginPatterns(Collections.singletonList("*"));
    configuration.setAllowedMethods(
        Arrays.asList("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
    configuration.setAllowedHeaders(Arrays.asList("Authorization", "Content-Type"));
    configuration.setExposedHeaders(Collections.singletonList("Authorization"));
    configuration.setAllowCredentials(true);
    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    source.registerCorsConfiguration("/**", configuration);
    return source;
  }
}
