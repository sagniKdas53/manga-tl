package com.manga.library;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultHandlers.print;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.config.JwtUtils;
import com.manga.library.dto.ChapterDto;
import com.manga.library.model.Series;
import com.manga.library.model.User;
import com.manga.library.repository.SeriesRepository;
import com.manga.library.repository.UserRepository;
import java.util.Objects;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

@SpringBootTest
@AutoConfigureMockMvc
@Transactional
@ActiveProfiles("test")
public class JwtTest {

  @Autowired private MockMvc mockMvc;

  @Autowired private ObjectMapper objectMapper;

  @Autowired private JwtUtils jwtUtils;

  @Autowired private SeriesRepository seriesRepository;

  @Autowired private UserRepository userRepository;

  @Test
  public void testPostChapter() throws Exception {
    // Save mock admin user to avoid 403 Forbidden on role check
    userRepository
        .findByEmail("admin@manga.local")
        .orElseGet(
            () -> {
              User buildUser =
                  new User() {{ setEmail("admin@manga.local"); setPasswordHash("mock_password_hash"); setDisplayName("Admin User"); setRole("admin"); }};
              Objects.requireNonNull(buildUser, "user cannot be null");
              return userRepository.save(buildUser);
            });

    // Save test series programmatically
    Series series =
        new Series() {{ setTitle("Test Series"); setOriginalLanguage("ja"); setReadingDirection("rtl"); }};
    Objects.requireNonNull(series, "series cannot be null");
    series = seriesRepository.save(series);

    // Generate dynamically signed JWT token
    String token = "Bearer " + jwtUtils.generateToken("admin@manga.local");

    ChapterDto dto = new ChapterDto();
    dto.setChapterNumber(1.0);
    dto.setTitle("One");

    mockMvc
        .perform(
            post("/api/series/" + series.getId() + "/chapters")
                .header("Authorization", token)
                .contentType(Objects.requireNonNull(MediaType.APPLICATION_JSON))
                .content(Objects.requireNonNull(objectMapper.writeValueAsString(dto))))
        .andDo(print())
        .andExpect(status().isOk());
  }

  @org.springframework.beans.factory.annotation.Value(
      "${internal.api-token:manga-library-internal-token-12345}")
  private String internalApiToken;

  @Test
  public void testInternalAuthFilter_MissingToken() throws Exception {
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get(
                    "/api/internal/images/" + java.util.UUID.randomUUID())
                .servletPath("/api/internal"))
        .andExpect(status().isUnauthorized());
  }

  @Test
  public void testInternalAuthFilter_IncorrectToken() throws Exception {
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get(
                    "/api/internal/images/" + java.util.UUID.randomUUID())
                .servletPath("/api/internal")
                .header("X-Internal-Token", "wrong-token"))
        .andExpect(status().isUnauthorized());
  }

  @Test
  public void testInternalAuthFilter_CorrectToken() throws Exception {
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get(
                    "/api/internal/images/" + java.util.UUID.randomUUID())
                .servletPath("/api/internal")
                .header("X-Internal-Token", internalApiToken))
        .andExpect(status().isNotFound());
  }

  @Test
  public void testPostChapter_QueryParameterToken() throws Exception {
    userRepository
        .findByEmail("admin@manga.local")
        .orElseGet(
            () -> {
              User buildUser =
                  new User() {{ setEmail("admin@manga.local"); setPasswordHash("mock_password_hash"); setDisplayName("Admin User"); setRole("admin"); }};
              Objects.requireNonNull(buildUser, "user cannot be null");
              return userRepository.save(buildUser);
            });

    Series series =
        new Series() {{ setTitle("Test Series QueryParam"); setOriginalLanguage("ja"); setReadingDirection("rtl"); }};
    Objects.requireNonNull(series, "series cannot be null");
    series = seriesRepository.save(series);

    String rawToken = jwtUtils.generateToken("admin@manga.local");

    ChapterDto dto = new ChapterDto();
    dto.setChapterNumber(2.0);
    dto.setTitle("Two");

    mockMvc
        .perform(
            post("/api/series/" + series.getId() + "/chapters")
                .param("token", rawToken)
                .contentType(Objects.requireNonNull(MediaType.APPLICATION_JSON))
                .content(Objects.requireNonNull(objectMapper.writeValueAsString(dto))))
        .andDo(print())
        .andExpect(status().isOk());
  }

  @Test
  public void testPostChapter_InvalidQueryParameterToken() throws Exception {
    mockMvc
        .perform(
            post("/api/series/" + java.util.UUID.randomUUID() + "/chapters")
                .param("token", "invalid-token-signature")
                .contentType(Objects.requireNonNull(MediaType.APPLICATION_JSON))
                .content("{}"))
        .andExpect(status().isForbidden());
  }

  @Test
  public void testPostChapter_UserNotFound() throws Exception {
    String token = "Bearer " + jwtUtils.generateToken("nonexistent@manga.local");

    mockMvc
        .perform(
            post("/api/series/" + java.util.UUID.randomUUID() + "/chapters")
                .header("Authorization", token)
                .contentType(Objects.requireNonNull(MediaType.APPLICATION_JSON))
                .content("{}"))
        .andExpect(status().isForbidden());
  }
}
