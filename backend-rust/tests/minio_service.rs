//! MinIO integration tests against a REAL server.
//!
//! Skipped unless MINIO_TEST_ENDPOINT is set. Locally, spin a throwaway instance:
//!
//! ```bash
//! docker run --rm -d --name rust-minio-test -p 19000:9000 \
//!   -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin minio/minio
//! MINIO_TEST_ENDPOINT=http://127.0.0.1:19000 cargo test --test minio_service
//! docker rm -f rust-minio-test
//! ```
//!
//! CI (ci-cargo.yml) starts the same image with `docker run` (service containers cannot
//! take the `server /data` argument minio/minio needs) and exports the same variables.

use manga_backend::config::MinioConfig;
use manga_backend::minio::MinioService;
use tokio::io::AsyncReadExt;

fn test_service() -> Option<MinioService> {
    let Ok(endpoint) = std::env::var("MINIO_TEST_ENDPOINT") else {
        // Skipping is right on a laptop with no MinIO, but in CI it would quietly turn
        // this whole file into a no-op that still reports green -- exactly the failure
        // you would not notice. ci-cargo.yml always exports the endpoint, so its absence
        // there means the workflow broke, not that there is nothing to test.
        assert!(
            std::env::var_os("CI").is_none(),
            "MINIO_TEST_ENDPOINT must be set under CI -- check the Start MinIO step and \
             the Test step env block in .github/workflows/ci-cargo.yml"
        );
        return None;
    };
    Some(MinioService::new(&MinioConfig {
        endpoint,
        external_url: None,
        access_key: std::env::var("MINIO_TEST_ACCESS_KEY")
            .ok()
            .or_else(|| Some("minioadmin".into())),
        secret_key: std::env::var("MINIO_TEST_SECRET_KEY")
            .ok()
            .or_else(|| Some("minioadmin".into())),
    }))
}

#[tokio::test]
async fn upload_stat_download_delete_roundtrip() {
    let Some(storage) = test_service() else {
        eprintln!("skipping: MINIO_TEST_ENDPOINT not set");
        return;
    };
    storage.ensure_bucket().await;

    let key = format!("__rust_probe/{}.bin", uuid::Uuid::new_v4());
    let payload = b"manga-page-bytes-0123456789".to_vec();

    storage
        .upload_bytes(&key, payload.clone(), "application/octet-stream")
        .await
        .expect("upload");

    assert!(
        storage.exists(&key).await,
        "object should exist after upload"
    );

    let stat = storage.stat(&key).await.expect("stat");
    assert_eq!(stat.content_length, Some(payload.len() as i64));
    assert_eq!(
        stat.content_type.as_deref(),
        Some("application/octet-stream")
    );

    let mut downloaded = Vec::new();
    storage
        .download(&key)
        .await
        .expect("download")
        .into_async_read()
        .read_to_end(&mut downloaded)
        .await
        .expect("read body");
    assert_eq!(downloaded, payload, "round-trip bytes must be identical");

    // Presigned URL carries query auth and points at the configured endpoint.
    let url = storage.presigned_get_url(&key).await.expect("presign");
    assert!(url.contains(&storage_endpoint()), "url {url}");
    assert!(
        url.contains("X-Amz-Signature"),
        "presigned urls must carry a signature"
    );

    storage.delete_quietly(&key).await;
    assert!(
        !storage.exists(&key).await,
        "object should be gone after delete"
    );
}

#[tokio::test]
async fn list_keys_under_prefix_finds_uploads() {
    let Some(storage) = test_service() else {
        eprintln!("skipping: MINIO_TEST_ENDPOINT not set");
        return;
    };
    storage.ensure_bucket().await;

    let prefix = format!("__rust_probe_list/{}/", uuid::Uuid::new_v4());
    for name in ["a.txt", "b.txt"] {
        storage
            .upload_bytes(&format!("{prefix}{name}"), b"x".to_vec(), "text/plain")
            .await
            .expect("upload");
    }

    let keys = storage.list_keys_under_prefix(&prefix).await;
    assert_eq!(keys.len(), 2, "both objects listed under prefix");

    for key in keys {
        storage.delete_quietly(&key).await;
    }
}

fn storage_endpoint() -> String {
    std::env::var("MINIO_TEST_ENDPOINT").unwrap_or_default()
}
