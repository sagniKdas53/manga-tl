package com.manga.library.config;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.manga.library.RedisTestcontainersConfig;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Import(RedisTestcontainersConfig.class)
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

  /**
   * The derived image variants are public <b>on purpose</b> — see the javadoc on {@link
   * SecurityConfig#filterChain}. This test exists so that closing them is a deliberate act that
   * breaks a named test, rather than a tidy-up that silently regresses the reader: an {@code <img>}
   * cannot send an Authorization header, so authenticating these costs progressive decoding,
   * browser request priority and the HTTP cache.
   *
   * <p>If you are here because this failed: do not simply relax the assertion. Either keep the route
   * public, or move it behind a short-TTL signed URL, which preserves native {@code <img>} loading.
   */
  @Test
  public void testDerivedImageVariantsAreDeliberatelyPublic() throws Exception {
    UUID imageId = UUID.randomUUID();
    for (String path : new String[] {"/thumbnail", "/reader"}) {
      // The invariant is "the security layer never rejects this", not any particular success code:
      // a missing image is 404 and an unimplemented variant falls through to the SPA forward. Only
      // 401/403 would mean the route had been closed.
      int status =
          mockMvc.perform(get("/api/images/" + imageId + path)).andReturn().getResponse().getStatus();
      org.junit.jupiter.api.Assertions.assertTrue(
          status != 401 && status != 403,
          "/api/images/*" + path + " must stay public — got " + status);
    }
  }

  /**
   * The other half of the boundary: opening the image bytes must not open anything that lists,
   * searches or mutates. Reaching an image requires already knowing its UUID, which is only true
   * while the catalogue stays authenticated.
   */
  @Test
  public void testBusinessEndpointsStayAuthenticated() throws Exception {
    UUID id = UUID.randomUUID();
    for (String path :
        new String[] {
          "/api/series", "/api/chapters/" + id, "/api/pages/" + id, "/api/images/" + id + "/file"
        }) {
      mockMvc.perform(get(path)).andExpect(status().isForbidden());
    }
  }
}
