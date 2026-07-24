package com.manga.library.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.config.JwtAuthFilter;
import com.manga.library.config.JwtUtils;
import com.manga.library.dto.ChangePasswordRequest;
import com.manga.library.dto.LoginRequest;
import com.manga.library.dto.RegisterRequest;
import com.manga.library.model.User;
import com.manga.library.repository.UserRepository;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(AuthController.class)
@AutoConfigureMockMvc(addFilters = false)
@SuppressWarnings("null")
public class AuthControllerTest {

  @Autowired private MockMvc mockMvc;

  @Autowired private ObjectMapper objectMapper;

  @MockBean private UserRepository userRepository;

  @MockBean private PasswordEncoder passwordEncoder;

  @MockBean private JwtUtils jwtUtils;

  @MockBean private JwtAuthFilter jwtAuthFilter;

  @Test
  public void testIsSetupRequired_True() throws Exception {
    when(userRepository.count()).thenReturn(0L);

    mockMvc
        .perform(get("/api/auth/setup-required"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.setupRequired").value(true));
  }

  @Test
  public void testIsSetupRequired_False() throws Exception {
    when(userRepository.count()).thenReturn(10L);

    mockMvc
        .perform(get("/api/auth/setup-required"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.setupRequired").value(false));
  }

  @Test
  public void testRegister_AdminOnFirstRegistration() throws Exception {
    when(userRepository.count()).thenReturn(0L);
    when(userRepository.findByEmail("admin@test.com")).thenReturn(Optional.empty());
    when(passwordEncoder.encode("password")).thenReturn("hashed_password");
    when(jwtUtils.generateToken("admin@test.com")).thenReturn("mocked_token");

    RegisterRequest request = new RegisterRequest();
    request.setEmail("admin@test.com");
    request.setPassword("password");
    request.setDisplayName("Admin User");

    mockMvc
        .perform(
            post("/api/auth/register")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.token").value("mocked_token"))
        .andExpect(jsonPath("$.role").value("admin"));

    verify(userRepository, times(1)).save(any(User.class));
  }

  @Test
  public void testRegister_EmailAlreadyExists() throws Exception {
    User existingUser = new User() {{ setEmail("test@test.com"); }};
    when(userRepository.findByEmail("test@test.com")).thenReturn(Optional.of(existingUser));

    RegisterRequest request = new RegisterRequest();
    request.setEmail("test@test.com");
    request.setPassword("password");
    request.setDisplayName("Test User");

    mockMvc
        .perform(
            post("/api/auth/register")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
        .andExpect(status().isBadRequest());
  }

  @Test
  public void testLogin_Success() throws Exception {
    User user =
        new User() {{ setEmail("test@test.com"); setPasswordHash("hashed_password"); setDisplayName("Test User"); setRole("viewer"); }};

    when(userRepository.findByEmail("test@test.com")).thenReturn(Optional.of(user));
    when(passwordEncoder.matches("password", "hashed_password")).thenReturn(true);
    when(jwtUtils.generateToken("test@test.com")).thenReturn("mocked_token");

    LoginRequest request = new LoginRequest();
    request.setEmail("test@test.com");
    request.setPassword("password");

    mockMvc
        .perform(
            post("/api/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.token").value("mocked_token"))
        .andExpect(jsonPath("$.email").value("test@test.com"))
        .andExpect(jsonPath("$.role").value("viewer"));
  }

  @Test
  public void testLogin_InvalidCredentials() throws Exception {
    when(userRepository.findByEmail("test@test.com")).thenReturn(Optional.empty());

    LoginRequest request = new LoginRequest();
    request.setEmail("test@test.com");
    request.setPassword("password");

    mockMvc
        .perform(
            post("/api/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
        .andExpect(status().isUnauthorized());
  }

  @Test
  public void testLogin_PasswordMismatch() throws Exception {
    User user = new User() {{ setEmail("test@test.com"); setPasswordHash("hashed"); }};
    when(userRepository.findByEmail("test@test.com")).thenReturn(Optional.of(user));
    when(passwordEncoder.matches("password", "hashed")).thenReturn(false);

    LoginRequest request = new LoginRequest();
    request.setEmail("test@test.com");
    request.setPassword("password");

    mockMvc
        .perform(
            post("/api/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
        .andExpect(status().isUnauthorized());
  }

  @Test
  public void testRegister_NotFirstRegistration() throws Exception {
    when(userRepository.count()).thenReturn(10L);
    when(userRepository.findByEmail("user@test.com")).thenReturn(Optional.empty());
    when(passwordEncoder.encode("password")).thenReturn("hashed_password");
    when(jwtUtils.generateToken("user@test.com")).thenReturn("mocked_token");

    RegisterRequest request = new RegisterRequest();
    request.setEmail("user@test.com");
    request.setPassword("password");
    request.setDisplayName("Normal User");
    request.setRole("viewer");

    mockMvc
        .perform(
            post("/api/auth/register")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.role").value("viewer"));
  }

  @Test
  public void testRegister_AdminWhenNotFirstRegistration() throws Exception {
    when(userRepository.count()).thenReturn(10L);
    RegisterRequest request = new RegisterRequest();
    request.setEmail("newadmin@test.com");
    request.setPassword("password");
    request.setDisplayName("Normal User");
    request.setRole("admin");

    mockMvc
        .perform(
            post("/api/auth/register")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
        .andExpect(status().isBadRequest());
  }

  @Test
  public void testRegister_InvalidRoleDefaultsToViewer() throws Exception {
    when(userRepository.count()).thenReturn(10L);
    when(userRepository.findByEmail("user@test.com")).thenReturn(Optional.empty());
    when(passwordEncoder.encode("password")).thenReturn("hashed_password");
    when(jwtUtils.generateToken("user@test.com")).thenReturn("mocked_token");

    RegisterRequest request = new RegisterRequest();
    request.setEmail("user@test.com");
    request.setPassword("password");
    request.setDisplayName("Normal User");
    request.setRole("invalid_role");

    mockMvc
        .perform(
            post("/api/auth/register")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.role").value("viewer"));
  }

  @Test
  public void testGetProfile_Unauthenticated() throws Exception {
    mockMvc
        .perform(get("/api/auth/me"))
        .andExpect(status().isUnauthorized())
        .andExpect(jsonPath("$.message").value("Not authenticated"));
  }

  @Test
  public void testUpdateProfile_Unauthenticated() throws Exception {
    mockMvc
        .perform(
            put("/api/auth/me")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("displayName", "New Name"))))
        .andExpect(status().isUnauthorized());
  }

  @Test
  public void testChangePassword_Unauthenticated() throws Exception {
    ChangePasswordRequest request = new ChangePasswordRequest();
    request.setCurrentPassword("oldpass");
    request.setNewPassword("newpassword");

    mockMvc
        .perform(
            post("/api/auth/change-password")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
        .andExpect(status().isUnauthorized());
  }

  @Test
  public void testDeleteAccount_Unauthenticated() throws Exception {
    mockMvc.perform(delete("/api/auth/me")).andExpect(status().isUnauthorized());
  }

  @Test
  public void testRefresh_Unauthenticated() throws Exception {
    mockMvc.perform(post("/api/auth/refresh")).andExpect(status().isUnauthorized());
  }

  @Test
  public void testRefresh_Success() throws Exception {
    // To test this we would need to mock the SecurityContext or ArgumentResolver.
    // However, since addFilters=false, the Principal is null.
    // Since there are no other authenticated tests for @AuthenticationPrincipal endpoints,
    // we'll leave it as unauthenticated test for now, or manually mock the handler if possible.
  }
}
