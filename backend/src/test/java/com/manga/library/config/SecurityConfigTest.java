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
  /**
   * AUDIT-B3: a denied {@code @PreAuthorize} used to come back as 500.
   *
   * <p>This advice sits inside the dispatcher, so it saw {@code AccessDeniedException} before
   * Spring Security's {@code ExceptionTranslationFilter} could, and the catch-all turned it into
   * "Something went wrong: Access Denied". A viewer opening any of {@code LayerController}'s eight
   * editor-only endpoints was told the server had broken.
   */
  @Test
  @org.springframework.security.test.context.support.WithMockUser(roles = "VIEWER")
  public void testInsufficientRoleIsForbidden_notAServerError() throws Exception {
    mockMvc
        .perform(get("/api/layer-elements/" + UUID.randomUUID() + "/history"))
        .andExpect(status().isForbidden());
  }

  /** The same endpoint with a role that does hold the permission gets past the check. */
  @Test
  @org.springframework.security.test.context.support.WithMockUser(roles = "TRANSLATOR")
  public void testSufficientRoleIsNotForbidden() throws Exception {
    // Asserting "not 403" rather than 200: the point is the authorization decision, and an empty
    // history for a random id is a perfectly good 200 either way.
    mockMvc
        .perform(get("/api/layer-elements/" + UUID.randomUUID() + "/history"))
        .andExpect(status().isOk());
  }

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
