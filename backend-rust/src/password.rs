//! Password hashing — BCrypt, verified compatible with Spring's `BCryptPasswordEncoder`.
//!
//! PARITY:
//! - Java encodes with default strength 10 and the `$2a$` version prefix; the live
//!   `users.password_hash` column holds exactly that (verified: `$2a$10$`, 60 chars).
//! - The bcrypt crate defaults to `$2b$`, which Spring would still VERIFY — but we pin
//!   `$2a$` anyway so new hashes are byte-indistinguishable from Java-era ones.
//! - Verification accepts any version prefix ($2a/$2b/$2y) so every hash written by the
//!   Java backend keeps working after cutover.
//!
//! Rust refresher: cost is the log2 of the internal work factor — each +1 doubles the
//! hashing time. Cost 10 is the historical default and what the existing rows use.

use bcrypt::{HashParts, Version, hash_with_salt, verify};
use getrandom::fill as fill_random;

/// Spring's BCryptPasswordEncoder default.
pub const BCRYPT_COST: u32 = 10;

/// Hashes a plaintext password into a `$2a$10$...` string (60 chars), matching what
/// AuthController stored via `passwordEncoder.encode`.
pub fn hash_password(plain: &str) -> String {
    let mut salt = [0u8; 16];
    fill_random(&mut salt).expect("OS randomness is always available on our targets");

    let parts: HashParts =
        hash_with_salt(plain, BCRYPT_COST, salt).expect("fixed cost/version are always valid");
    parts.format_for_version(Version::TwoA) // the crate's Display would emit $2b$
}

/// Constant-work verify against a stored hash. False for malformed hashes too.
pub fn verify_password(plain: &str, stored_hash: &str) -> bool {
    verify(plain, stored_hash).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Produced by the RUNNING Java backend on 2026-08-23 (POST /api/auth/register with
    /// role=viewer) and read back from Postgres. The plaintext is a throwaway probe
    /// ("__rust-probe-pw") with zero security value; the hash is a permanent cross-
    /// implementation regression guard — if this stops verifying, cutover locks users out.
    const SPRING_HASH_OF_RUST_PROBE_PW: &str =
        "$2a$10$1Y28cgdJDLY91c2XrpXcP.FwptinsCSr97AA0.Ee9.DmiGZf.KYaW";

    #[test]
    fn hashes_look_like_spring_output() {
        let hashed = hash_password("some-password-123");
        assert!(hashed.starts_with("$2a$10$"), "got {hashed}");
        assert_eq!(hashed.len(), 60);
    }

    #[test]
    fn roundtrip_verifies() {
        let hashed = hash_password("correct horse battery staple");
        assert!(verify_password("correct horse battery staple", &hashed));
        assert!(!verify_password("wrong", &hashed));
        assert!(!verify_password("", &hashed));
    }

    #[test]
    fn unique_salts_produce_unique_hashes() {
        assert_ne!(hash_password("same"), hash_password("same"));
    }

    #[test]
    fn verifies_hash_written_by_java_backend() {
        assert!(verify_password(
            "__rust-probe-pw",
            SPRING_HASH_OF_RUST_PROBE_PW
        ));
        assert!(!verify_password(
            "__rust-probe-wrong",
            SPRING_HASH_OF_RUST_PROBE_PW
        ));
    }

    #[test]
    fn malformed_hashes_verify_false_not_panic() {
        assert!(!verify_password("x", "not-a-hash"));
        assert!(!verify_password("x", ""));
    }
}
