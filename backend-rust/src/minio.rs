//! MinIO object storage — port of Java `MinioService`.
//!
//! Rust refresher:
//! - We use the AWS S3 SDK because MinIO speaks the S3 protocol. Two things make it
//!   "MinIO mode": a custom `endpoint_url` and `force_path_style(true)` (MinIO has no
//!   virtual-host domains, so object paths must be host/bucket/key).
//! - The region string is required by the SDK but ignored by MinIO; "us-east-1" is the
//!   conventional placeholder.
//! - All operations are `async` and return `Result`; errors surface to callers instead
//!   of being swallowed (the Java version's catch-and-log is mirrored ONLY for
//!   bucket-creation at startup, where @PostConstruct did exactly that).
//!
//! PARITY NOTES:
//! - Bucket name fixed to "manga-library" (= application.yml `minio.bucketName`).
//! - Presigned GET URLs live 10 minutes, and when MINIO_EXTERNAL_URL is set the endpoint
//!   part of the URL is replaced by it — same trick generatePresignedUrl uses so browsers
//!   reach presigned links from outside the docker network.
//! - Deviation: Java tolerated missing credentials until first call (empty yml defaults);
//!   here empty creds build a client whose calls simply fail with 403. Same observable
//!   behavior, no startup crash.
//!
//! LINT NOTE: `#[allow(clippy::result_large_err)]` — the AWS SDK's SdkError enum is
//! several hundred bytes by design (it embeds full HTTP responses); boxing every call
//! site buys nothing here. This is the widely-used exemption for aws-sdk-* crates.

#![allow(clippy::result_large_err)]

use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::primitives::ByteStream;

/// Fixed in application.yml (`minio.bucketName`) on the Java side.
pub const BUCKET_NAME: &str = "manga-library";

#[derive(Clone)]
pub struct MinioService {
    client: aws_sdk_s3::Client,
    bucket: String,
    endpoint: String,
    external_url: Option<String>,
}

impl MinioService {
    pub fn new(minio: &crate::config::MinioConfig) -> Self {
        let credentials = Credentials::new(
            minio.access_key.clone().unwrap_or_default(),
            minio.secret_key.clone().unwrap_or_default(),
            None,
            None,
            "minio-static",
        );
        let s3_config = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("us-east-1"))
            .endpoint_url(&minio.endpoint)
            .credentials_provider(credentials)
            .force_path_style(true)
            .build();
        Self {
            client: aws_sdk_s3::Client::from_conf(s3_config),
            bucket: BUCKET_NAME.to_string(),
            endpoint: minio.endpoint.clone(),
            external_url: minio.external_url.clone().filter(|u| !u.trim().is_empty()),
        }
    }

    /// Creates the bucket if missing, mirroring the @PostConstruct init(): failures are
    /// logged, not fatal, so a temporarily-down MinIO doesn't block boot.
    pub async fn ensure_bucket(&self) {
        let exists = self
            .client
            .head_bucket()
            .bucket(&self.bucket)
            .send()
            .await
            .is_ok();
        if !exists {
            match self
                .client
                .create_bucket()
                .bucket(&self.bucket)
                .send()
                .await
            {
                Ok(_) => tracing::info!("Successfully created MinIO bucket: {}", self.bucket),
                Err(err) => tracing::error!("Failed to initialize MinIO bucket: {err}"),
            }
        }
    }

    /// Uploads raw bytes with a content type; returns the object path like Java does.
    pub async fn upload_bytes(
        &self,
        object_path: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<(), aws_sdk_s3::error::SdkError<aws_sdk_s3::operation::put_object::PutObjectError>>
    {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(object_path)
            .content_type(content_type)
            .body(ByteStream::from(bytes))
            .send()
            .await?;
        Ok(())
    }

    /// Downloads an object as a streaming body (no full-buffer requirement).
    pub async fn download(
        &self,
        object_path: &str,
    ) -> Result<
        ByteStream,
        aws_sdk_s3::error::SdkError<aws_sdk_s3::operation::get_object::GetObjectError>,
    > {
        Ok(self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(object_path)
            .send()
            .await?
            .body)
    }

    /// Object metadata (size, etag, content type). Errors propagate; callers decide.
    pub async fn stat(
        &self,
        object_path: &str,
    ) -> Result<
        aws_sdk_s3::operation::head_object::HeadObjectOutput,
        aws_sdk_s3::error::SdkError<aws_sdk_s3::operation::head_object::HeadObjectError>,
    > {
        self.client
            .head_object()
            .bucket(&self.bucket)
            .key(object_path)
            .send()
            .await
    }

    pub async fn exists(&self, object_path: &str) -> bool {
        self.stat(object_path).await.is_ok()
    }

    /// Convenience alias used by the export service (Java fileExists).
    pub async fn file_exists(&self, object_path: &str) -> bool {
        self.exists(object_path).await
    }

    /// Downloads an object fully; None when it does not exist or the download fails.
    pub async fn download_bytes(&self, object_path: &str) -> Option<Vec<u8>> {
        let mut stream = match self.download(object_path).await {
            Ok(stream) => stream,
            Err(err) => {
                tracing::debug!("download of {object_path} failed: {err}");
                return None;
            }
        };
        let mut buffer = Vec::new();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => buffer.extend_from_slice(&bytes),
                Err(err) => {
                    tracing::debug!("download of {object_path} interrupted: {err}");
                    return None;
                }
            }
        }
        Some(buffer)
    }

    /// Deletes every object under a prefix (ChapterExportService.clearChapterExports).
    pub async fn delete_by_prefix(
        &self,
        prefix: &str,
    ) -> Result<
        (),
        aws_sdk_s3::error::SdkError<aws_sdk_s3::operation::delete_object::DeleteObjectError>,
    > {
        for key in self.list_keys_under_prefix(prefix).await {
            self.delete_quietly(&key).await;
        }
        Ok(())
    }

    /// Deletes objects under a prefix whose last-modified time predates `age`
    /// (the scheduled stale-export sweeps).
    pub async fn delete_older_than(
        &self,
        prefix: &str,
        age: chrono::Duration,
    ) -> Result<
        (),
        aws_sdk_s3::error::SdkError<aws_sdk_s3::operation::delete_object::DeleteObjectError>,
    > {
        let cutoff = chrono::Utc::now() - age;
        let mut deleted = 0usize;
        for key in self.list_keys_under_prefix(prefix).await {
            let last_modified = self
                .stat(&key)
                .await
                .ok()
                .and_then(|meta| meta.last_modified)
                .map(|t| {
                    let system_time: std::time::SystemTime =
                        t.try_into().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                    chrono::DateTime::<chrono::Utc>::from(system_time)
                });
            if last_modified.map(|lm| lm < cutoff).unwrap_or(false) {
                self.delete_quietly(&key).await;
                deleted += 1;
            }
        }
        tracing::info!(
            "Deleted {deleted} stale exports older than {} days.",
            age.num_days()
        );
        Ok(())
    }

    /// Deletes silently on failure, exactly like deleteFile's catch-and-log.
    pub async fn delete_quietly(&self, object_path: &str) {
        match self
            .client
            .delete_object()
            .bucket(&self.bucket)
            .key(object_path)
            .send()
            .await
        {
            Ok(_) => tracing::info!("Successfully deleted MinIO file: {object_path}"),
            Err(err) => tracing::error!("Failed to delete MinIO file: {object_path}: {err}"),
        }
    }

    /// Keys under a prefix, collected eagerly (Java returned a lazy Iterable; our callers
    /// always materialize it for cleanup loops anyway).
    pub async fn list_keys_under_prefix(&self, prefix: &str) -> Vec<String> {
        let mut keys = Vec::new();
        let mut pages = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(prefix)
            .into_paginator()
            .send();
        while let Some(page) = pages.next().await {
            if let Ok(page) = page {
                keys.extend(
                    page.contents()
                        .iter()
                        .filter_map(|obj| obj.key().map(str::to_string)),
                );
            }
        }
        keys
    }

    /// 10-minute presigned GET URL, rewritten onto MINIO_EXTERNAL_URL when configured.
    pub async fn presigned_get_url(
        &self,
        object_path: &str,
    ) -> Result<
        String,
        aws_sdk_s3::error::SdkError<aws_sdk_s3::operation::get_object::GetObjectError>,
    > {
        let presigning = PresigningConfig::builder()
            .expires_in(Duration::from_secs(10 * 60))
            .build()
            .expect("fixed 10-minute expiry is valid");
        let url = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(object_path)
            .presigned(presigning)
            .await?
            .uri()
            .to_string();

        Ok(match &self.external_url {
            Some(external) => url.replace(&self.endpoint, external),
            None => url,
        })
    }
}
