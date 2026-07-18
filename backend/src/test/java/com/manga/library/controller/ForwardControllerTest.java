package com.manga.library.controller;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.forwardedUrl;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.manga.library.config.JwtAuthFilter;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(ForwardController.class)
@AutoConfigureMockMvc(addFilters = false)
@SuppressWarnings("null")
public class ForwardControllerTest {

  @Autowired private MockMvc mockMvc;

  @MockBean private JwtAuthFilter jwtAuthFilter;

  @Test
  public void testForwardFrontendPath() throws Exception {
    mockMvc
        .perform(get("/some-frontend-route"))
        .andExpect(status().isOk())
        .andExpect(forwardedUrl("/index.html"));
  }

  @Test
  public void testForwardApiPath() throws Exception {
    mockMvc
        .perform(get("/api/some-api-route"))
        .andExpect(
            status()
                .isOk()) // Since it's a forward, the status returned by perform might be OK, but
        // forwardedUrl is /error
        .andExpect(forwardedUrl("/error"));
  }

  @Test
  public void testForwardWithContextPath() throws Exception {
    mockMvc
        .perform(get("/myapp/some-frontend-route").contextPath("/myapp"))
        .andExpect(status().isOk())
        .andExpect(forwardedUrl("/index.html"));
  }
}
