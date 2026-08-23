//! Server-Sent Events: ports Java `SseService`, `SseTicketService` and the ticket
//! authentication path of `SseTicketAuthFilter`/`NotificationController`.
//!
//! The wire contract (what the browser sees):
//!   * every new connection first receives `event: connected` /
//!     `data: SSE Connection Established`;
//!   * notifications arrive as `event: notification` with a JSON payload;
//!   * job events arrive under their own names (`job_update`, `queue_paused`, ...);
//!   * a connection whose JWT expiry is known gets ONE `session-expired` event at that
//!     moment and is then closed (the client clears its stored token on receipt);
//!   * undelivered notifications queue in Redis (`notifications:user:{id}`) and are
//!     replayed right after `connected` on the next subscribe.
//!
//! Authentication of the stream itself: `EventSource` cannot send headers, so the browser
//! POSTs `/api/notifications/ticket` WITH its Authorization header and opens the stream
//! with `?ticket=<single-use>` instead. Tickets live 60 seconds and die on first use
//! (GETDEL), so a leaked URL buys an attacker nothing.
//!
//! Rust refresher:
//! - There is no SseEmitter object to hold. Each connection owns a tokio mpsc channel;
//!   the registry stores the sender halves. A per-connection actor task implements the
//!   lifecycle (session-expired push, Spring's 1h emitter timeout, disconnect detection)
//!   with `select!`, and unregisters its sender when any arm fires. When the last sender
//!   disappears the response body ends — exactly `emitter.complete()`.
//! - `UnboundedSender::closed()` resolves once the receiving half is dropped, which is
//!   how the actor notices a client that simply walked away.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use chrono::{DateTime, Utc};
use futures_util::stream::unfold;
use uuid::Uuid;

const NOTIFICATION_PREFIX: &str = "notifications:user:";
const IMAGE_USER_MAPPING_PREFIX: &str = "job:owner:image:";
const TICKET_PREFIX: &str = "sse:ticket:";
/// The event name the browser listens for; it clears the stored session on receipt.
const SESSION_EXPIRED_EVENT: &str = "session-expired";
/// Spring constructed its SseEmitter with a 3_600_000 ms timeout: the server closes the
/// stream after an hour and the browser's EventSource reconnects automatically.
const EMITTER_TIMEOUT: Duration = Duration::from_secs(3600);
/// How long an undelivered notification waits for the user to open a connection.
const PENDING_TTL_SECS: u64 = 7 * 24 * 3600;
/// How long the image→owner mapping lives (Java: Duration.ofHours(24)).
const IMAGE_MAPPING_TTL_SECS: u64 = 24 * 3600;
/// Long enough that guessing is hopeless inside the TTL.
const TICKET_BYTES: usize = 32;
const TICKET_TTL_SECS: u64 = 60;
/// Separates the user id from the session expiry in the stored ticket value.
const FIELD_SEPARATOR: char = '|';

// ---------------------------------------------------------------------------
// Ticket service (port of SseTicketService)
// ---------------------------------------------------------------------------

/// What a redeemed ticket was issued against.
#[derive(Debug, Clone, PartialEq)]
pub struct Ticket {
    pub user_id: Uuid,
    /// When the JWT that bought the ticket expires; None ⇒ the stream arms no
    /// session-expired push (also the shape of pre-AUDIT-F7 stored values).
    pub session_expires_at: Option<DateTime<Utc>>,
}

#[derive(Clone)]
pub struct SseTicketService {
    redis: Arc<crate::redis_service::RedisService>,
}

impl SseTicketService {
    pub fn new(redis: Arc<crate::redis_service::RedisService>) -> Self {
        Self { redis }
    }

    /// Mints a ticket for `user_id`, valid for [`TICKET_TTL_SECS`] and one connection.
    /// `sessionExpiresAt` rides along because the stream request carries nothing but
    /// the ticket — the JWT was presented on the POST and never again.
    pub async fn issue(
        &self,
        user_id: Uuid,
        session_expires_at: Option<DateTime<Utc>>,
    ) -> Result<String, redis::RedisError> {
        let mut bytes = [0u8; TICKET_BYTES];
        getrandom::fill(&mut bytes)
            .map_err(|e| redis::RedisError::from(std::io::Error::other(e.to_string())))?;
        let ticket = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let value = ticket_value(user_id, session_expires_at);
        self.redis
            .set_ex(&format!("{TICKET_PREFIX}{ticket}"), &value, TICKET_TTL_SECS)
            .await?;
        Ok(ticket)
    }

    /// Redeems a ticket. The GETDEL makes it single-use: a ticket captured from a log
    /// after the connection opened is already spent.
    pub async fn redeem(&self, ticket: &str) -> Result<Option<Ticket>, redis::RedisError> {
        if ticket.trim().is_empty() {
            return Ok(None);
        }
        let stored = self
            .redis
            .get_and_delete(&format!("{TICKET_PREFIX}{ticket}"))
            .await?;
        Ok(stored.as_deref().and_then(parse_ticket_value))
    }
}

/// `{userId}` or `{userId}|{epochMilli}` — identical layout to the Java side, so tickets
/// minted by the outgoing instance stay redeemable for a minute after a deploy.
fn ticket_value(user_id: Uuid, expires_at: Option<DateTime<Utc>>) -> String {
    match expires_at {
        None => user_id.to_string(),
        Some(at) => format!("{user_id}{FIELD_SEPARATOR}{}", at.timestamp_millis()),
    }
}

/// Inverse of [`ticket_value`]. Malformed pieces degrade exactly like Java: a bad uuid
/// voids the ticket, a bad epoch-milli merely costs the session-expired push.
fn parse_ticket_value(stored: &str) -> Option<Ticket> {
    let (user_part, expiry_part) = match stored.split_once(FIELD_SEPARATOR) {
        Some((u, e)) => (u, Some(e)),
        None => (stored, None),
    };
    let user_id = Uuid::parse_str(user_part).ok()?;
    let session_expires_at = expiry_part.and_then(|millis| {
        millis
            .parse::<i64>()
            .ok()
            .and_then(DateTime::from_timestamp_millis)
    });
    Some(Ticket {
        user_id,
        session_expires_at,
    })
}

// ---------------------------------------------------------------------------
// SseService (port of SseService)
// ---------------------------------------------------------------------------

/// One frame queued for a connection, pre-formatted so the yield loop stays trivial.
/// Public because open_connection hands receivers to integration tests.
#[derive(Debug, Clone)]
pub struct SseMessage {
    pub event: String,
    pub data: String,
}

impl SseMessage {
    fn new(event: &str, data: impl Into<String>) -> Self {
        Self {
            event: event.to_string(),
            data: data.into(),
        }
    }

    fn into_event(self) -> Event {
        Event::default().event(self.event).data(self.data)
    }
}

type Senders = Vec<(u64, tokio::sync::mpsc::UnboundedSender<SseMessage>)>;

/// Drops one emitter entry; drops the user's key entirely once the last
/// connection goes (no empty collections left behind).
fn remove_emitter(emitters: &Mutex<HashMap<Uuid, Senders>>, user_id: Uuid, subscription_id: u64) {
    let mut emitters = emitters.lock().expect("emitter registry poisoned");
    if let Some(connections) = emitters.get_mut(&user_id) {
        connections.retain(|(id, _)| *id != subscription_id);
        if connections.is_empty() {
            emitters.remove(&user_id);
        }
    }
}

pub struct SseService {
    redis: Option<Arc<crate::redis_service::RedisService>>,
    pool: sqlx::PgPool,
    tickets: Option<SseTicketService>,
    /// userId → live connections. AUDIT-B4: several connections per user are normal
    /// (second tab, phone next to laptop); a plain map put used to evict tab one.
    emitters: Arc<Mutex<HashMap<Uuid, Senders>>>,
    next_subscription_id: std::sync::atomic::AtomicU64,
}

impl SseService {
    pub fn new(pool: sqlx::PgPool, redis: Option<Arc<crate::redis_service::RedisService>>) -> Self {
        let tickets = redis.clone().map(SseTicketService::new);
        Self {
            redis,
            pool,
            tickets,
            emitters: Arc::new(Mutex::new(HashMap::new())),
            next_subscription_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// The ticket mint/redeem service; None only in tests that run without Redis.
    pub fn tickets(&self) -> Option<&SseTicketService> {
        self.tickets.as_ref()
    }

    /// Registers a connection, emits `connected`, replays pending notifications and
    /// arms the lifecycle actor. Returns the receiving half — `subscribe` wraps it in
    /// an SSE response; tests consume it directly.
    pub async fn open_connection(
        &self,
        user_id: Uuid,
        session_expires_at: Option<DateTime<Utc>>,
    ) -> tokio::sync::mpsc::UnboundedReceiver<SseMessage> {
        let subscription_id = self
            .next_subscription_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<SseMessage>();

        {
            let mut emitters = self.emitters.lock().expect("emitter registry poisoned");
            emitters
                .entry(user_id)
                .or_default()
                .push((subscription_id, tx.clone()));
        }

        let _ = tx.send(SseMessage::new("connected", "SSE Connection Established"));
        self.send_pending_notifications(user_id, &tx).await;

        // Lifecycle actor: whichever fires first wins, then this connection leaves the
        // registry. With the registry copy AND our copy gone the channel closes and the
        // response body ends — the equivalent of emitter.complete().
        //
        // The closed() arm is the disconnect detector (receiver dropped): it cancels the
        // other two timers, which is Java's "cancel the scheduled expiry push on
        // completion" — a tab closed at noon must not leave a task holding its emitter
        // until midnight.
        let emitters = Arc::clone(&self.emitters);
        let life_tx = tx.clone();
        tokio::spawn(async move {
            let expiry_push = async {
                match session_expires_at {
                    Some(at) => {
                        let delay = (at - Utc::now()).to_std().unwrap_or(Duration::ZERO);
                        tokio::time::sleep(delay).await;
                    }
                    // No readable exp on the buying token: no push is armed, ever.
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                _ = expiry_push => {
                    // Closed too — the client drops its token on this event, so leaving
                    // the stream open would only invite a reconnect carrying a JWT that
                    // can no longer buy a ticket.
                    let _ = life_tx
                        .send(SseMessage::new(SESSION_EXPIRED_EVENT, r#"{"reason":"expired"}"#));
                }
                _ = tokio::time::sleep(EMITTER_TIMEOUT) => {}
                _ = life_tx.closed() => {}
            }
            remove_emitter(&emitters, user_id, subscription_id);
        });

        rx
    }

    /// The HTTP face of open_connection: an SSE response with a keep-alive heartbeat
    /// (comment frames; EventSource ignores them but intermediate proxies see traffic).
    pub async fn subscribe(
        &self,
        user_id: Uuid,
        session_expires_at: Option<DateTime<Utc>>,
    ) -> Response {
        let rx = self.open_connection(user_id, session_expires_at).await;
        let stream = unfold(rx, |mut rx| async move {
            rx.recv()
                .await
                .map(|message| (Ok::<_, std::convert::Infallible>(message.into_event()), rx))
        });
        Sse::new(stream)
            .keep_alive(
                KeepAlive::new()
                    .interval(Duration::from_secs(15))
                    .text("keep-alive"),
            )
            .into_response()
    }

    /// Sends to every live connection this user has, pruning the ones that fail.
    /// Returns true if at least one connection took the event — callers use this to
    /// decide whether the payload still needs queueing in Redis for later delivery.
    fn send_to_user(&self, user_id: Uuid, message: &SseMessage) -> bool {
        let mut delivered = false;
        let mut emitters = self.emitters.lock().expect("emitter registry poisoned");
        if let Some(connections) = emitters.get_mut(&user_id) {
            connections.retain(|(_, tx)| match tx.send(message.clone()) {
                Ok(()) => {
                    delivered = true;
                    true
                }
                Err(_) => false, // dead connection — prune it like Java's failed send
            });
            if connections.is_empty() {
                emitters.remove(&user_id);
            }
        }
        delivered
    }

    /// Delivers everything queued while the user had no open connection.
    ///
    /// The whole list moves aside with RENAME in one operation: anything pushed a
    /// microsecond later lands on a fresh key this drain has no handle on (the old
    /// range-then-delete lost such items). A RENAME error means another tab drained it
    /// between the size check and here — nothing left to deliver, not a failure.
    async fn send_pending_notifications(
        &self,
        user_id: Uuid,
        tx: &tokio::sync::mpsc::UnboundedSender<SseMessage>,
    ) {
        let Some(redis) = &self.redis else { return };
        let key = format!("{NOTIFICATION_PREFIX}{user_id}");
        let Ok(size) = redis.queue_size(&key).await else {
            return;
        };
        if size <= 0 {
            return; // empty is the overwhelmingly common case: no RENAME at all
        }

        let draining = format!("{}:draining:{}", key, Uuid::new_v4());
        if redis.rename(&key, &draining).await.is_err() {
            return; // raced away; either way there is nothing left to deliver
        }
        let pending = redis.list_range(&draining).await.unwrap_or_default();
        let _ = redis.delete(&draining).await;

        for (index, payload) in pending.iter().enumerate() {
            if tx
                .send(SseMessage::new("notification", payload.clone()))
                .is_err()
            {
                // Connection died mid-replay: put the UNSENT tail back at the head.
                // LPUSH prepends argument by argument, so the tail goes in backwards
                // to come out in order (and already-seen items must NOT come back).
                let unsent: Vec<String> = pending[index..].iter().rev().cloned().collect();
                let _ = redis.lpush_all(&key, &unsent).await;
                let _ = redis.expire(&key, PENDING_TTL_SECS).await;
                return;
            }
        }
    }

    /// Records which user owns an image so pipeline callbacks can find their audience.
    pub async fn map_image_to_user(&self, image_id: Uuid, user_id: Uuid) {
        let Some(redis) = &self.redis else { return };
        let _ = redis
            .set_ex(
                &format!("{IMAGE_USER_MAPPING_PREFIX}{image_id}"),
                &user_id.to_string(),
                IMAGE_MAPPING_TTL_SECS,
            )
            .await;
    }

    /// Resolves the owner of an image: Redis mapping first, then the DB `created_by`,
    /// backfilling the mapping on the way out. Warns (like Java) when nobody is found.
    async fn owner_of_image(&self, image_id: Uuid) -> Option<Uuid> {
        let mapped = match &self.redis {
            Some(redis) => redis
                .get(&format!("{IMAGE_USER_MAPPING_PREFIX}{image_id}"))
                .await
                .ok()
                .flatten(),
            None => None,
        };
        if let Some(user) = mapped.and_then(|s| Uuid::parse_str(&s).ok()) {
            return Some(user);
        }

        let created_by: Option<Option<Uuid>> =
            sqlx::query_scalar("SELECT created_by FROM images WHERE id = $1")
                .bind(image_id)
                .fetch_optional(&self.pool)
                .await
                .ok()
                .flatten();
        match created_by.flatten() {
            Some(user) => {
                self.map_image_to_user(image_id, user).await;
                Some(user)
            }
            None => {
                tracing::warn!(
                    "Could not find owner user for image {image_id} in Redis or DB. Cannot send SSE."
                );
                None
            }
        }
    }

    /// Notification with job context; falls back to the DB when no mapping exists.
    pub async fn emit_notification_for_image(
        &self,
        image_id: Uuid,
        kind: &str,
        title: &str,
        message: &str,
        context: Option<&HashMap<String, String>>,
    ) {
        if let Some(user) = self.owner_of_image(image_id).await {
            self.emit_notification_to_user_with_context(
                user,
                kind,
                title,
                message,
                Some(image_id),
                context,
            )
            .await;
        }
    }

    /// Queue-or-send core: live tabs take the event immediately; only when NO tab took
    /// it does it go to Redis, so nothing is ever shown twice.
    pub async fn emit_notification_to_user_with_context(
        &self,
        user_id: Uuid,
        kind: &str,
        title: &str,
        message: &str,
        image_id: Option<Uuid>,
        context: Option<&HashMap<String, String>>,
    ) {
        let payload = notification_payload(kind, title, message, image_id, context);
        let json = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
        if self.send_to_user(user_id, &SseMessage::new("notification", json.clone())) {
            return;
        }
        if let Some(redis) = &self.redis {
            let key = format!("{NOTIFICATION_PREFIX}{user_id}");
            let _ = redis.push_to_queue(&key, &json).await;
            let _ = redis.expire(&key, PENDING_TTL_SECS).await;
        }
    }

    pub async fn emit_notification_to_user(
        &self,
        user_id: Uuid,
        kind: &str,
        title: &str,
        message: &str,
    ) {
        self.emit_notification_to_user_with_context(user_id, kind, title, message, None, None)
            .await;
    }

    /// Broadcasts to every connected user (queue pause/resume, clear, ...).
    pub fn emit_event_to_all_users(&self, event_name: &str, data_json: &str) {
        let message = SseMessage::new(event_name, data_json.to_string());
        let user_ids: Vec<Uuid> = {
            let emitters = self.emitters.lock().expect("emitter registry poisoned");
            emitters.keys().copied().collect()
        };
        for user_id in user_ids {
            self.send_to_user(user_id, &message);
        }
    }

    /// Job-scoped event; resolves the audience like emit_notification_for_image.
    pub async fn emit_event_for_image(&self, image_id: Uuid, event_name: &str, data_json: &str) {
        if let Some(user) = self.owner_of_image(image_id).await {
            self.emit_event_to_user(user, event_name, data_json);
        }
    }

    /// Direct event to one user; live delivery only (events are not queued).
    pub fn emit_event_to_user(&self, user_id: Uuid, event_name: &str, data_json: &str) {
        self.send_to_user(user_id, &SseMessage::new(event_name, data_json));
    }

    /// Visible for testing: how many live connections a user currently holds.
    pub fn connection_count(&self, user_id: Uuid) -> usize {
        let emitters = self.emitters.lock().expect("emitter registry poisoned");
        emitters.get(&user_id).map_or(0, Vec::len)
    }
}

/// Jackson-parity notification JSON: id/type/title/message/timestamp always present,
/// imageId and context only when given. Timestamp is epoch MILLIS like
/// `System.currentTimeMillis()`.
fn notification_payload(
    kind: &str,
    title: &str,
    message: &str,
    image_id: Option<Uuid>,
    context: Option<&HashMap<String, String>>,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "id": Uuid::new_v4().to_string(),
        "type": kind,
        "title": title,
        "message": message,
        "timestamp": Utc::now().timestamp_millis(),
    });
    if let Some(image_id) = image_id {
        payload["imageId"] = serde_json::Value::String(image_id.to_string());
    }
    if let Some(context) = context {
        payload["context"] = serde_json::to_value(context).unwrap_or(serde_json::Value::Null);
    }
    payload
}

// -------------------------------------------------------------------------------------------
// Tests (pure parts; Redis-backed behaviour lives in tests/sse_endpoints.rs)
// -------------------------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_value_roundtrips_with_and_without_expiry() {
        let id = Uuid::new_v4();
        let at = DateTime::from_timestamp_millis(1_755_000_000_123).unwrap();

        assert_eq!(
            parse_ticket_value(&ticket_value(id, None)),
            Some(Ticket {
                user_id: id,
                session_expires_at: None
            })
        );
        assert_eq!(ticket_value(id, Some(at)), format!("{id}|1755000000123"));
        assert_eq!(
            parse_ticket_value(&ticket_value(id, Some(at))),
            Some(Ticket {
                user_id: id,
                session_expires_at: Some(at)
            })
        );
    }

    #[test]
    fn legacy_shaped_ticket_values_still_parse() {
        // Pre-AUDIT-F7 keys were bare user ids; deploy-window tickets must connect.
        let id = Uuid::new_v4();
        let parsed = parse_ticket_value(&id.to_string()).unwrap();
        assert_eq!(parsed.user_id, id);
        assert_eq!(parsed.session_expires_at, None);

        // A malformed epoch costs the push, not the connection.
        let parsed = parse_ticket_value(&format!("{id}|not-a-number")).unwrap();
        assert_eq!(parsed.user_id, id);
        assert_eq!(parsed.session_expires_at, None);

        // Garbage user ids void the ticket outright.
        assert_eq!(parse_ticket_value("nope"), None);
    }

    #[test]
    fn notification_payload_matches_jackson_shape() {
        let image = Uuid::new_v4();
        let mut context = HashMap::new();
        context.insert("chapterNumber".to_string(), "3".to_string());

        let full = notification_payload(
            "translation_done",
            "Ttl",
            "Msg",
            Some(image),
            Some(&context),
        );
        assert_eq!(full["type"], "translation_done");
        assert_eq!(full["title"], "Ttl");
        assert_eq!(full["message"], "Msg");
        assert_eq!(full["imageId"], image.to_string());
        assert_eq!(full["context"]["chapterNumber"], "3");
        // Millisecond timestamp, like System.currentTimeMillis().
        assert!(full["timestamp"].as_i64().unwrap() > 1_700_000_000_000);
        assert!(full["id"].as_str().is_some());

        let bare = notification_payload("t", "ti", "me", None, None);
        assert!(bare.get("imageId").is_none());
        assert!(bare.get("context").is_none());
    }

    #[test]
    fn requeue_order_keeps_fifo_after_lpush() {
        // Drain got [a, b, c]; sending b failed. Only [b, c] goes back, and because
        // LPUSH prepends one at a time they must be pushed c-first to come out b-then-c.
        let drained = ["a".to_string(), "b".to_string(), "c".to_string()];
        let unsent: Vec<String> = drained[1..].iter().rev().cloned().collect();
        assert_eq!(unsent, vec!["c".to_string(), "b".to_string()]);
        // lpush_all(key, ["c","b"]) leaves the list as ["b","c"] — FIFO preserved.
    }

    #[test]
    fn sse_message_carries_connected_frame_fields() {
        let message = SseMessage::new("connected", "SSE Connection Established");
        // Rendering belongs to axum's Sse body; here we pin the fields we set.
        assert_eq!(message.event, "connected");
        assert_eq!(message.data, "SSE Connection Established");
    }
}
