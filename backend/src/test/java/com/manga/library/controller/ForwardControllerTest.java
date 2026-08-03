package com.manga.library.controller;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.forwardedUrl;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.manga.library.config.JwtAuthFilter;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(ForwardController.class)
@AutoConfigureMockMvc(addFilters = false)
public class ForwardControllerTest {

  @Autowired private MockMvc mockMvc;

  @MockitoBean private JwtAuthFilter jwtAuthFilter;

  @MockitoBean private com.manga.library.config.SseTicketAuthFilter sseTicketAuthFilter;

  @Test
  public void testForwardFrontendPath() throws Exception {
    mockMvc
        .perform(get("/some-frontend-route"))
        .andExpect(status().isOk())
        .andExpect(forwardedUrl("/index.html"));
  }

  /**
   * An unmatched API path must 404. The previous {@code forward:/error} reached the error
   * controller but left the status at 200, so this test asserted {@code isOk()} — it was pinning
   * the bug rather than the behaviour.
   */
  @Test
  public void testUnmatchedApiPathIsNotFound() throws Exception {
    mockMvc.perform(get("/api/some-api-route")).andExpect(status().isNotFound());
  }

  @Test
  public void testUnmatchedApiPathIsNotFoundUnderContextPath() throws Exception {
    mockMvc
        .perform(get("/myapp/api/some-api-route").contextPath("/myapp"))
        .andExpect(status().isNotFound());
  }

  /** A 404 for /api must not come back as the SPA shell, or the client cannot tell them apart. */
  @Test
  public void testUnmatchedApiPathIsNotForwardedToIndex() throws Exception {
    mockMvc.perform(get("/api/some-api-route")).andExpect(forwardedUrl(null));
  }

  @Test
  public void testForwardWithContextPath() throws Exception {
    mockMvc
        .perform(get("/myapp/some-frontend-route").contextPath("/myapp"))
        .andExpect(status().isOk())
        .andExpect(forwardedUrl("/index.html"));
  }
}
