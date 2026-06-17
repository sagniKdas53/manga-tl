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
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

@SpringBootTest
@AutoConfigureMockMvc
@Transactional
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
                  User.builder()
                      .email("admin@manga.local")
                      .passwordHash("mock_password_hash")
                      .displayName("Admin User")
                      .role("admin")
                      .build();
              Objects.requireNonNull(buildUser, "user cannot be null");
              return userRepository.save(buildUser);
            });

    // Save test series programmatically
    Series series =
        Series.builder()
            .title("Test Series")
            .originalLanguage("ja")
            .readingDirection("rtl")
            .build();
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
}
