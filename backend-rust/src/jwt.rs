//! JWT issuing and validation — port of Java `JwtUtils`.
//!
//! Rust refresher:
//! - A JWT is three base64 chunks (header.payload.signature). We only ever *sign* and
//!   *verify* (HMAC-SHA family, shared secret) — the Java side does the same.
//! - `jsonwebtoken` is our jjwt equivalent: a `Header` + your claims struct get serialized,
//!   signed, and joined; decoding reverses it AND enforces expiry/algorithm.
//! - Claims: `sub` (subject = user email), `exp` (expiry, unix seconds), `iat` (issued at).
//! - `Result<T, E>` returns force callers to handle failure; `Option` marks "may be absent"
//!   exactly like the null-returning Java method this mirrors.
//!
//! PARITY NOTES (vs JwtUtils.java):
//! 1. jjwt's `Keys.hmacShaKeyFor` picks the HMAC variant from KEY LENGTH:
//!    64+ bytes -> HS512, 48+ -> HS384, otherwise HS256.
//!    The production secret length is whatever is in the secrets file, so we reproduce that
//!    selection for signing AND verification — otherwise tokens issued by the running Java
//!    backend would fail to validate here (or vice versa) whenever it picked HS384/HS512.
//! 2. jjwt applies ZERO clock skew on `exp`; jsonwebtoken defaults to 60s of leeway, which
//!    we set back to 0 to keep session-expiry behavior identical.
//! 3. `getExpiryFromToken` returned null on ANY parse failure — mirrored as `None`.

use chrono::{Duration, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};

/// The claim set we mint and accept. Field names are JWT-registered names.
#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    /// Subject: the authenticated user's email (Java used `.subject(email)`).
    pub sub: String,
    /// Expiry, seconds since unix epoch.
    pub exp: i64,
    /// Issued-at, seconds since unix epoch.
    pub iat: i64,
}

#[derive(Clone)]
pub struct JwtUtils {
    secret: String,
    expiration_ms: i64,
}

impl JwtUtils {
    pub fn new(secret: String, expiration_ms: i64) -> Self {
        Self {
            secret,
            expiration_ms,
        }
    }

    /// Mirrors jjwt's key-length-based algorithm selection; see module docs.
    /// (`str::len` is the BYTE length in Rust, which is exactly what the rule uses.)
    fn algorithm(&self) -> Algorithm {
        match self.secret.len() {
            len if len >= 64 => Algorithm::HS512,
            len if len >= 48 => Algorithm::HS384,
            _ => Algorithm::HS256,
        }
    }

    /// Signs `email` into a token expiring after the configured lifetime.
    /// Errors only on encoding problems, which with a validated secret is effectively never.
    pub fn generate_token(&self, email: &str) -> Result<String, jsonwebtoken::errors::Error> {
        let now = Utc::now();
        let claims = Claims {
            sub: email.to_string(),
            iat: now.timestamp(),
            // i64 arithmetic — the AUDIT-B8 int overflow cannot happen here by construction.
            exp: (now + Duration::milliseconds(self.expiration_ms)).timestamp(),
        };
        encode(
            &Header::new(self.algorithm()),
            &claims,
            &self.encoding_key(),
        )
    }

    /// Extracts the subject email. Returns Err when signature/expiry/algorithm checks fail.
    pub fn email_from_token(&self, token: &str) -> Result<String, jsonwebtoken::errors::Error> {
        decode::<Claims>(token, &self.decoding_key(), &self.validation())
            .map(|data| data.claims.sub)
    }

    /// The token's `exp`, or None when invalid or absent — mirrors getExpiryFromToken's
    /// deliberate null-on-failure contract (a session without readable expiry still works).
    pub fn expiry_from_token(&self, token: &str) -> Option<chrono::DateTime<Utc>> {
        let data = decode::<Claims>(token, &self.decoding_key(), &self.validation()).ok()?;
        chrono::DateTime::from_timestamp(data.claims.exp, 0)
    }

    /// True when the token's signature, algorithm and expiry all check out.
    pub fn validate_token(&self, token: &str) -> bool {
        decode::<Claims>(token, &self.decoding_key(), &self.validation()).is_ok()
    }

    fn encoding_key(&self) -> EncodingKey {
        EncodingKey::from_secret(self.secret.as_bytes())
    }

    fn decoding_key(&self) -> DecodingKey {
        DecodingKey::from_secret(self.secret.as_bytes())
    }

    /// Zero clock skew (jjwt parity) and no required-claims list beyond what decode enforces.
    fn validation(&self) -> Validation {
        let mut validation = Validation::new(self.algorithm());
        validation.leeway = 0;
        validation
    }
}

// -------------------------------------------------------------------------------------------
// Tests — mirror JwtUtilsTest plus cross-compatibility cases the Java suite cannot express.
// -------------------------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    /// The exact literal from JwtUtilsTest. Its *name* says sha-256, but at 57 bytes
    /// jjwt's key-length rule selects HS384 — a quirk that is irrelevant over there
    /// (sign and verify use the same key) and must be mirrored here.
    const JAVA_TEST_SECRET: &str = "a-test-signing-key-long-enough-for-hmac-sha-256-abcdefgh";

    /// Exactly 32 bytes: the minimum our startup validation accepts -> HS256.
    const MIN_SECRET: &str = "0123456789abcdef0123456789abcdef";

    fn utils(secret: &str, expiration_ms: i64) -> JwtUtils {
        JwtUtils::new(secret.to_string(), expiration_ms)
    }

    /// AUDIT-B8 regression: a >int-range expiry must still land in the future.
    /// In Rust this "just works" (i64 everywhere); kept as a parity guard.
    #[test]
    fn thirty_day_expiry_lands_in_the_future() {
        let thirty_days_ms = 30i64 * 24 * 60 * 60 * 1000;
        assert!(thirty_days_ms > i32::MAX as i64);

        let u = utils(JAVA_TEST_SECRET, thirty_days_ms);
        let before = Utc::now();
        let expiry = u
            .expiry_from_token(&u.generate_token("someone@example.com").unwrap())
            .expect("no exp claim came back");

        assert!(expiry > before, "expiry {expiry} is not after {before}");
    }

    /// The ordinary configured value (24 h) is unchanged.
    #[test]
    fn one_day_expiry_matches_configuration() {
        let one_day_ms = 86_400_000;
        let u = utils(JAVA_TEST_SECRET, one_day_ms);
        let now = Utc::now();
        let expiry = u
            .expiry_from_token(&u.generate_token("someone@example.com").unwrap())
            .unwrap();

        let delta_ms = (expiry - now).num_milliseconds();
        assert!(
            (delta_ms - one_day_ms).abs() < 5_000,
            "expiry was {delta_ms} ms out, expected ~{one_day_ms}"
        );
    }

    #[test]
    fn generated_token_roundtrips_email() {
        let u = utils(JAVA_TEST_SECRET, 3_600_000);
        let token = u.generate_token("reader@example.com").unwrap();
        assert_eq!(u.email_from_token(&token).unwrap(), "reader@example.com");
        assert!(u.validate_token(&token));
    }

    #[test]
    fn tampered_token_is_rejected() {
        let u = utils(JAVA_TEST_SECRET, 3_600_000);
        let token = u.generate_token("reader@example.com").unwrap();

        // Flip one character inside the payload section (the middle chunk).
        let mut parts: Vec<String> = token.split('.').map(str::to_string).collect();
        if parts[1].starts_with('e') {
            parts[1].replace_range(0..1, "x");
        } else {
            parts[1].replace_range(0..1, "e");
        }

        assert!(!u.validate_token(&parts.join(".")));
    }

    #[test]
    fn wrong_signing_key_is_rejected() {
        let issuer = utils(JAVA_TEST_SECRET, 3_600_000);
        let verifier = utils(
            "another-secret-long-enough-for-hs256-padding-here",
            3_600_000,
        );
        let token = issuer.generate_token("reader@example.com").unwrap();
        assert!(!verifier.validate_token(&token));
    }

    #[test]
    fn expired_token_is_rejected_with_zero_leeway() {
        let u = utils(JAVA_TEST_SECRET, -10_000); // minted already expired
        let token = u.generate_token("reader@example.com").unwrap();
        assert!(!u.validate_token(&token));
        assert!(u.email_from_token(&token).is_err());
        assert_eq!(u.expiry_from_token(&token), None);
    }

    #[test]
    fn garbage_tokens_yield_none_and_false() {
        let u = utils(JAVA_TEST_SECRET, 3_600_000);
        assert!(!u.validate_token("not-a-jwt"));
        assert_eq!(u.expiry_from_token("not-a-jwt"), None);
    }

    /// Cross-compat guard: jjwt picks HS256/HS384/HS512 from secret length, so tokens
    /// issued by the Java backend must verify here under every length bucket.
    #[test]
    fn long_secrets_select_hmac_variant_by_length() {
        // The Java test fixture is 57 bytes -> HS384 despite its sha-256 name.
        assert_eq!(utils(JAVA_TEST_SECRET, 1).algorithm(), Algorithm::HS384);

        // Exactly 32 bytes -> HS256.
        assert_eq!(utils(MIN_SECRET, 1).algorithm(), Algorithm::HS256);
        let u32 = utils(MIN_SECRET, 3_600_000);
        let t32 = u32.generate_token("a@b.c").unwrap();
        assert!(u32.validate_token(&t32));

        let secret48 = "0123456789abcdef0123456789abcdef0123456789abcdef"; // 48 bytes
        assert_eq!(utils(secret48, 1).algorithm(), Algorithm::HS384);
        let u48 = utils(secret48, 3_600_000);
        let t48 = u48.generate_token("a@b.c").unwrap();
        assert!(u48.validate_token(&t48));

        let secret64 = "0".repeat(64);
        assert_eq!(utils(&secret64, 1).algorithm(), Algorithm::HS512);
        let u64 = utils(&secret64, 3_600_000);
        let t64 = u64.generate_token("a@b.c").unwrap();
        assert!(u64.validate_token(&t64));

        // A verifier pinned to a different length-bucket rejects: alg pinning matters.
        assert!(!u32.validate_token(&t64));
    }
}
