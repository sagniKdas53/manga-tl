//! Redis integration tests against a REAL server (local compose valkey on 6379 or the CI
//! service container). Skipped unless REDIS_TEST_ADDR is set (e.g. "127.0.0.1:6379").

use futures_util::StreamExt;
use manga_backend::redis_service::{PROVIDER_CONFIG_CHANNEL, RedisService};

async fn service() -> Option<RedisService> {
    let addr = std::env::var("REDIS_TEST_ADDR").ok()?;
    let (host, port) = addr.split_once(':')?;
    RedisService::connect(host, port.parse().expect("numeric port"))
        .await
        .ok()
}

#[tokio::test]
async fn string_get_set_roundtrip() {
    let Some(redis) = service().await else {
        eprintln!("skipping: REDIS_TEST_ADDR not set");
        return;
    };
    let key = format!("__rust_probe:{}", uuid::Uuid::new_v4());
    redis.set(&key, "pong").await.expect("set");
    assert_eq!(redis.get(&key).await.expect("get").as_deref(), Some("pong"));
    redis.delete(&key).await.expect("delete");
    assert_eq!(redis.get(&key).await.expect("get"), None);
}

#[tokio::test]
async fn queue_push_pop_preserves_order_and_counts() {
    let Some(redis) = service().await else {
        eprintln!("skipping: REDIS_TEST_ADDR not set");
        return;
    };
    let queue = format!("queue:__rust_probe:{}", uuid::Uuid::new_v4());

    redis
        .push_to_queue(&queue, r#"{"id":"first"}"#)
        .await
        .expect("push 1");
    redis
        .push_to_queue(&queue, r#"{"id":"second"}"#)
        .await
        .expect("push 2");

    assert_eq!(redis.queue_size(&queue).await.expect("size"), 2);
    // LPOP takes the FRONT: first-in first-out.
    assert_eq!(
        redis
            .pop_from_queue(&queue)
            .await
            .expect("pop 1")
            .as_deref(),
        Some(r#"{"id":"first"}"#)
    );
    assert_eq!(redis.queue_size(&queue).await.expect("size"), 1);

    redis.delete(&queue).await.expect("cleanup queue");
}

#[tokio::test]
async fn pause_gate_roundtrip() {
    let Some(redis) = service().await else {
        eprintln!("skipping: REDIS_TEST_ADDR not set");
        return;
    };
    // Clean any leftover gate from previous runs.
    redis.set_queue_paused(false).await.expect("unpause");
    assert!(!redis.queue_paused().await.expect("read"));

    redis.set_queue_paused(true).await.expect("pause");
    assert!(redis.queue_paused().await.expect("read"));

    redis.set_queue_paused(false).await.expect("restore");
    assert!(!redis.queue_paused().await.expect("read"));
}

#[tokio::test]
async fn publish_reaches_subscriber_on_provider_channel() {
    let Some(redis) = service().await else {
        eprintln!("skipping: REDIS_TEST_ADDR not set");
        return;
    };

    let mut pubsub = redis
        .subscribe(PROVIDER_CONFIG_CHANNEL)
        .await
        .expect("subscribe");
    // Give SUBSCRIBE a beat to register before publishing.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    redis
        .publish(PROVIDER_CONFIG_CHANNEL, "probe-payload")
        .await
        .expect("publish");

    let message = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        pubsub.on_message().next(),
    )
    .await
    .expect("timed out waiting for published message")
    .expect("stream ended");
    assert_eq!(
        message.get_payload::<String>().as_deref(),
        Ok("probe-payload")
    );
}
