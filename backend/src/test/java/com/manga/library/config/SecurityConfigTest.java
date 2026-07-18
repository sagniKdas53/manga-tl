package com.manga.library.config;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@SuppressWarnings({"null", "unchecked", "rawtypes", "unused"})
public class SecurityConfigTest {

  @Autowired private MockMvc mockMvc;

  @Test
  public void testImageFileEndpoint_RequiresAuth() throws Exception {
    UUID imageId = UUID.randomUUID();
    mockMvc
        .perform(get("/api/images/" + imageId + "/file"))
        .andExpect(status().isForbidden()); // Expect 403 when no token is provided
  }

  @Test
  public void testImageThumbnailEndpoint_DoesNotRequireAuth() throws Exception {
    UUID imageId = UUID.randomUUID();
    // It should hit the endpoint, but since the image doesn't exist in DB, it returns 404 (not 401)
    mockMvc.perform(get("/api/images/" + imageId + "/thumbnail")).andExpect(status().isNotFound());
  }
}
