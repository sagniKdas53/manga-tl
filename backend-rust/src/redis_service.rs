//! Redis/Valkey plumbing — the Rust equivalent of Spring's `StringRedisTemplate` usage
//! plus the pub/sub listener from `RedisSubscriptionConfig`.
//!
//! What the Java backend actually does with Redis (and what we therefore provide):
//!   * LIST queues named `queue:*` — jobs are pushed by us (RPUSH) and popped by the
//!     Python worker (LPOP); failed dispatch re-pushes to the BACK.
//!   * STRING keys — `system:queue:paused` gate, `health:ping` probe.
//!   * PUB/SUB — channel `provider:config:updated` tells every process to drop its
//!     cached provider config.
//!
//! Rust refresher:
//! - `redis::Client::get_connection_manager()` returns a `ConnectionManager`: a cloneable,
//!   automatically-reconnecting async connection. Cloning the service clones a handle,
//!   like sharing the pooled template in Java.
//! - `cmd("RPUSH").arg(..).arg(..)` builds commands; `.query_async::<T>()` decodes the
//!   reply into any `FromRedisValue` type (`String`, `i64`, `Option<String>`, ...).
//!
//! DEVIATION (deliberate): Spring boots happily when Redis is down because its template is
//! lazy; problems surface later as exceptions inside scheduler threads. Here connecting at
//! startup FAILS boot. In this stack compose already gates the backend on healthy Redis, so
//! the stricter contract costs nothing and removes a silent-degradation mode.

use redis::AsyncCommands;
use redis::aio::{ConnectionManager, PubSub};

const QUEUE_PAUSED_KEY: &str = "system:queue:paused";
pub const PROVIDER_CONFIG_CHANNEL: &str = "provider:config:updated";

#[derive(Clone)]
pub struct RedisService {
    client: redis::Client,
    /// Regular command connection: cloneable and auto-reconnecting. Pub/Sub cannot share
    /// a multiplexed connection (it switches protocol mode), so subscribers get their own
    /// via the client below.
    conn: ConnectionManager,
}

impl RedisService {
    /// Opens a connection and fails fast if Redis is unreachable.
    pub async fn connect(host: &str, port: u16) -> Result<Self, redis::RedisError> {
        let client = redis::Client::open((host, port))?;
        // get_connection_manager retries forever with no output — against a wrong host
        // (bad env spelling, wrong container network) the process would sit here
        // silently for days. Bound it: compose gates this service on Redis health
        // anyway, and a loud failure beats an infinite quiet one.
        let conn = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            client.get_connection_manager(),
        )
        .await
        .map_err(|_| {
            redis::RedisError::from((
                redis::ErrorKind::Io,
                "Redis connection not established within 15s",
            ))
        })??;
        Ok(Self { client, conn })
    }

    // ------------------------------------------------------------- queue lists

    /// RPUSH: append job JSON to the back of a queue (what pushJobToRedis does).
    pub async fn push_to_queue(&self, queue: &str, job_json: &str) -> redis::RedisResult<()> {
        let mut conn = self.conn.clone();
        conn.rpush(queue, job_json).await.map(|_: i64| ())
    }

    /// LPOP: take the next job off the front (the worker's side of the same queue;
    /// provided here for tests and future admin tooling).
    pub async fn pop_from_queue(&self, queue: &str) -> redis::RedisResult<Option<String>> {
        let mut conn = self.conn.clone();
        conn.lpop(queue, None).await
    }

    /// LLEN: how many entries are waiting on a queue.
    pub async fn queue_size(&self, queue: &str) -> redis::RedisResult<i64> {
        let mut conn = self.conn.clone();
        conn.llen(queue).await
    }

    // ------------------------------------------------------------ string values

    pub async fn get(&self, key: &str) -> redis::RedisResult<Option<String>> {
        let mut conn = self.conn.clone();
        conn.get(key).await
    }

    pub async fn set(&self, key: &str, value: &str) -> redis::RedisResult<()> {
        let mut conn = self.conn.clone();
        conn.set(key, value).await.map(|_: ()| ())
    }

    /// DEL a key; returns how many keys were removed.
    pub async fn delete(&self, key: &str) -> redis::RedisResult<i64> {
        let mut conn = self.conn.clone();
        conn.del(key).await
    }

    // ------------------------------------------------- keyed strings with expiry
    // (SSE tickets + image→owner mapping; Java used opsForValue().set(key, val, Duration))

    /// SET with a TTL in seconds — the SSE ticket write and the 24h owner mapping.
    pub async fn set_ex(&self, key: &str, value: &str, ttl_secs: u64) -> redis::RedisResult<()> {
        let mut conn = self.conn.clone();
        conn.set_ex(key, value, ttl_secs).await.map(|_: ()| ())
    }

    /// GETDEL — atomically reads and deletes. This atomicity is what makes an SSE ticket
    /// single-use (a captured-after-connect ticket is already spent).
    pub async fn get_and_delete(&self, key: &str) -> redis::RedisResult<Option<String>> {
        redis::cmd("GETDEL")
            .arg(key)
            .query_async(&mut self.conn.clone())
            .await
    }

    // ---------------------------------------------------------------- list extras

    /// LRANGE 0 -1 helper for draining pending-notification queues.
    pub async fn list_range(&self, key: &str) -> redis::RedisResult<Vec<String>> {
        let mut conn = self.conn.clone();
        conn.lrange(key, 0, -1).await
    }

    /// LPUSH with several values, inserted one at a time at the head: after
    /// `lpush_all(k, [a, b])` the list is `[b, a]`. Callers wanting FIFO order must
    /// therefore pass the batch reversed (same arithmetic as Java's leftPushAll).
    pub async fn lpush_all(&self, key: &str, values: &[String]) -> redis::RedisResult<()> {
        let mut cmd = redis::cmd("LPUSH");
        cmd.arg(key);
        for value in values {
            cmd.arg(value);
        }
        cmd.query_async(&mut self.conn.clone()).await
    }

    /// EXPIRE on an existing key (pending-notification queues get a 7-day TTL).
    pub async fn expire(&self, key: &str, ttl_secs: u64) -> redis::RedisResult<()> {
        let mut conn = self.conn.clone();
        conn.expire(key, ttl_secs as i64).await.map(|_: bool| ())
    }

    // ------------------------------------------------------------------- rename

    /// RENAME from → to. Errors when the source is gone, which the pending-drain treats
    /// as "another tab won the race" rather than a failure.
    pub async fn rename(&self, from: &str, to: &str) -> redis::RedisResult<()> {
        redis::cmd("RENAME")
            .arg(from)
            .arg(to)
            .query_async(&mut self.conn.clone())
            .await
    }

    /// The global pause gate checked by WorkerDispatcherService each cycle.
    pub async fn queue_paused(&self) -> redis::RedisResult<bool> {
        Ok(self.get(QUEUE_PAUSED_KEY).await?.is_some())
    }

    pub async fn set_queue_paused(&self, paused: bool) -> redis::RedisResult<()> {
        if paused {
            self.set(QUEUE_PAUSED_KEY, "true").await
        } else {
            let mut conn = self.conn.clone();
            conn.del(QUEUE_PAUSED_KEY).await.map(|_: i64| ())
        }
    }

    // ------------------------------------------------------------------ pub/sub

    /// PUBLISH on a channel; used for provider-config invalidation fan-out.
    pub async fn publish(&self, channel: &str, message: &str) -> redis::RedisResult<i64> {
        redis::cmd("PUBLISH")
            .arg(channel)
            .arg(message)
            .query_async(&mut self.conn.clone())
            .await
    }

    /// SUBSCRIBE and hand back the live subscription stream. The caller owns the loop:
    /// `while let Some(msg) = pubsub.on_message().next().await { ... }`.
    pub async fn subscribe(&self, channel: &str) -> redis::RedisResult<PubSub> {
        let mut pubsub = self.client.get_async_pubsub().await?;
        pubsub.subscribe(channel).await?;
        Ok(pubsub)
    }
}
