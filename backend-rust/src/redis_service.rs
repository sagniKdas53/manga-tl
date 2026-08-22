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
        let conn = client.get_connection_manager().await?;
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
