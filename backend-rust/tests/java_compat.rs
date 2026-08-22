//! Live cross-implementation compatibility tests.
//!
//! Each test is gated on an env var and SKIPS when it is absent, so plain
//! `cargo test` and CI never need the production stack. Locally they prove that
//! artifacts produced by the RUNNING Java backend verify in our Rust code:
//!
//! ```bash
//! # 1. A real bcrypt hash from users.password_hash (see src/password.rs for the
//! #    committed one; this test takes any pair):
//! JAVA_BCRYPT_HASH='$2a$10$...' JAVA_BCRYPT_PW='plaintext' cargo test --test java_compat
//!
//! # 2. A token from POST /api/auth/login against the running backend, signed with
//! #    the production secret file (64 bytes -> HS512):
//! JWT_SECRET_FILE=../secrets/jwt_secret.txt \
//! JAVA_JWT_TOKEN='eyJ...' cargo test --test java_compat -- --nocapture
//! ```

use manga_backend::jwt::JwtUtils;
use manga_backend::password::verify_password;

#[tokio::test]
async fn spring_bcrypt_hash_verifies() {
    let Ok(hash) = std::env::var("JAVA_BCRYPT_HASH") else {
        eprintln!("skipping: JAVA_BCRYPT_HASH not set");
        return;
    };
    let pw = std::env::var("JAVA_BCRYPT_PW").expect("JAVA_BCRYPT_PW must accompany the hash");
    assert!(
        verify_password(&pw, &hash),
        "Rust must verify Java's bcrypt hash"
    );
}

#[test]
fn java_minted_jwt_validates() {
    let Some(token) = std::env::var("JAVA_JWT_TOKEN").ok() else {
        eprintln!("skipping: JAVA_JWT_TOKEN not set");
        return;
    };
    let secret_path =
        std::env::var("JWT_SECRET_FILE").expect("JWT_SECRET_FILE must point at the live secret");
    let secret = std::fs::read_to_string(&secret_path)
        .expect("secret file readable")
        .trim()
        .to_string();
    println!(
        "production secret is {} bytes -> jjwt signs HS{}",
        secret.len(),
        match secret.len() {
            len if len >= 64 => 512,
            len if len >= 48 => 384,
            _ => 256,
        }
    );

    let utils = JwtUtils::new(secret, 86_400_000);
    let email = utils
        .email_from_token(&token)
        .expect("Java-minted token must validate with matching secret + algorithm");
    println!("validated email: {email}");
}
