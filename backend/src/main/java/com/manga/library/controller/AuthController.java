package com.manga.library.controller;

import com.manga.library.config.JwtUtils;
import com.manga.library.dto.AuthResponse;
import com.manga.library.dto.ChangePasswordRequest;
import com.manga.library.dto.LoginRequest;
import com.manga.library.dto.RegisterRequest;
import com.manga.library.model.User;
import com.manga.library.repository.UserRepository;
import java.util.Map;
import java.util.Objects;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

  private final UserRepository userRepository;
  private final PasswordEncoder passwordEncoder;
  private final JwtUtils jwtUtils;

  @GetMapping("/setup-required")
  public ResponseEntity<?> isSetupRequired() {
    boolean required = userRepository.count() == 0;
    return ResponseEntity.ok(java.util.Map.of("setupRequired", required));
  }

  @PostMapping("/register")
  public ResponseEntity<?> register(
      @jakarta.validation.Valid @RequestBody RegisterRequest request) {
    if (userRepository.findByEmail(request.getEmail()).isPresent()) {
      return ResponseEntity.badRequest().body("Email already exists");
    }

    long userCount = userRepository.count();
    String assignedRole;
    if (userCount == 0) {
      assignedRole = "admin";
    } else {
      if (request.getRole() == null || "admin".equalsIgnoreCase(request.getRole())) {
        return ResponseEntity.badRequest()
            .body("Cannot register as Admin. Admin is created on first registration.");
      }
      assignedRole = request.getRole().toLowerCase();
      if (!assignedRole.equals("translator") && !assignedRole.equals("viewer")) {
        assignedRole = "viewer";
      }
    }

    User user =
        User.builder()
            .email(request.getEmail())
            .passwordHash(passwordEncoder.encode(request.getPassword()))
            .displayName(request.getDisplayName())
            .role(assignedRole)
            .build();

    Objects.requireNonNull(user, "user cannot be null");
    userRepository.save(user);
    String token = jwtUtils.generateToken(user.getEmail());
    return ResponseEntity.ok(
        new AuthResponse(
            token, user.getId(), user.getEmail(), user.getDisplayName(), user.getRole()));
  }

  @PostMapping("/login")
  public ResponseEntity<?> login(@jakarta.validation.Valid @RequestBody LoginRequest request) {
    User user = userRepository.findByEmail(request.getEmail()).orElse(null);

    if (user == null || !passwordEncoder.matches(request.getPassword(), user.getPasswordHash())) {
      return ResponseEntity.status(401).body("Invalid credentials");
    }

    String token = jwtUtils.generateToken(user.getEmail());
    return ResponseEntity.ok(
        new AuthResponse(
            token, user.getId(), user.getEmail(), user.getDisplayName(), user.getRole()));
  }

  @GetMapping("/me")
  public ResponseEntity<?> getProfile(@AuthenticationPrincipal User user) {
    if (user == null)
      return ResponseEntity.status(401).body(Map.of("message", "Not authenticated"));
    return ResponseEntity.ok(
        new AuthResponse(
            null, user.getId(), user.getEmail(), user.getDisplayName(), user.getRole()));
  }

  @PutMapping("/me")
  public ResponseEntity<?> updateProfile(
      @AuthenticationPrincipal User user, @RequestBody Map<String, String> body) {
    if (user == null)
      return ResponseEntity.status(401).body(Map.of("message", "Not authenticated"));
    User dbUser = userRepository.findById(user.getId()).orElse(null);
    if (dbUser == null) return ResponseEntity.notFound().build();

    String displayName = body.get("displayName");
    if (displayName != null && !displayName.isBlank()) {
      dbUser.setDisplayName(displayName.trim());
      userRepository.save(dbUser);
    }
    return ResponseEntity.ok(
        new AuthResponse(
            null, dbUser.getId(), dbUser.getEmail(), dbUser.getDisplayName(), dbUser.getRole()));
  }

  @PostMapping("/change-password")
  public ResponseEntity<?> changePassword(
      @AuthenticationPrincipal User user,
      @jakarta.validation.Valid @RequestBody ChangePasswordRequest request) {
    if (user == null)
      return ResponseEntity.status(401).body(Map.of("message", "Not authenticated"));
    User dbUser = userRepository.findById(user.getId()).orElse(null);
    if (dbUser == null) return ResponseEntity.notFound().build();

    if (!passwordEncoder.matches(request.getCurrentPassword(), dbUser.getPasswordHash())) {
      return ResponseEntity.status(403).body(Map.of("message", "Current password is incorrect"));
    }

    dbUser.setPasswordHash(passwordEncoder.encode(request.getNewPassword()));
    userRepository.save(dbUser);
    return ResponseEntity.ok(Map.of("message", "Password changed successfully"));
  }

  @DeleteMapping("/me")
  public ResponseEntity<?> deleteAccount(@AuthenticationPrincipal User user) {
    if (user == null)
      return ResponseEntity.status(401).body(Map.of("message", "Not authenticated"));
    User dbUser = userRepository.findById(user.getId()).orElse(null);
    if (dbUser == null) return ResponseEntity.notFound().build();

    userRepository.delete(dbUser);
    return ResponseEntity.ok(Map.of("message", "Account deleted successfully"));
  }
}
