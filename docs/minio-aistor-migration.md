# Object storage: SeaweedFS, and what it replaced

**Status (2026-11-06): SeaweedFS (`chrislusf/seaweedfs:4.52`) runs in both compose files, CI and the test stacks (#271).** It replaced `purevert/minio:backup`, a frozen mirror of the last community MinIO image. The rest of this page is the old MinIO and AIStor plan, kept as history.

## What runs now

- `weed mini`: the master, volume server, filer and S3 gateway in one process, on one volume. It suits this stack, which has one storage node.
- **Unchanged for clients:** the S3 API on port 9000, the credentials file, bucket `manga-library`. The backend's `MinioService`, the worker's `minio` Python client and the `MINIO_*` settings keep their names, because they are S3 clients. Renaming them is a separate, cosmetic change.
- **Credentials:** `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; the compose files read the secret from `minio_password`.
- **Health:** `GET /healthz`.
- **Addressing:** `-ip=seaweedfs` names the compose service, so the data stays reachable when the container gets a new IP (tested).
- **Don't publish the filer.** Port 8888 takes unauthenticated reads and writes. Only the S3 port is ever published, and only on loopback. The admin UI listens inside the container only, so the old console port is gone.

## Checked against SeaweedFS (2026-11-06)

With the worker's client: multipart upload (40 MB), content types, Unicode keys, listing by prefix, presigned GET at 10 minutes and 7 days, refusal of expired and tampered links and of anonymous requests, wrong secret refused. Data survived a restart and a new container IP. The Rust suite runs against it in CI.

## Old data

**Nothing was migrated (owner, 2026-11-06).** SeaweedFS can't read MinIO's data directory, so old objects stay in `~/Projects/manga-tl-data-backup/` and in `data/minio` until you remove them. Objects alone don't appear in the app; they need their database too.

To copy a bucket from a running MinIO into SeaweedFS, on the same Docker network (tested on the test stack: 52 objects, `rclone check` reported 0 differences):

```sh
docker run --rm --network <network> --entrypoint sh \
  -e RCLONE_CONFIG_SRC_TYPE=s3 -e RCLONE_CONFIG_SRC_PROVIDER=Minio \
  -e RCLONE_CONFIG_SRC_ENDPOINT=http://minio:9000 \
  -e RCLONE_CONFIG_SRC_ACCESS_KEY_ID=minioadmin -e RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY="$MINIO_PASSWORD" \
  -e RCLONE_CONFIG_DST_TYPE=s3 -e RCLONE_CONFIG_DST_PROVIDER=SeaweedFS \
  -e RCLONE_CONFIG_DST_ENDPOINT=http://seaweedfs:9000 \
  -e RCLONE_CONFIG_DST_ACCESS_KEY_ID=minioadmin -e RCLONE_CONFIG_DST_SECRET_ACCESS_KEY="$MINIO_PASSWORD" \
  rclone/rclone:1.71 -c 'rclone mkdir dst:manga-library && rclone copy src:manga-library dst:manga-library --metadata && rclone check src:manga-library dst:manga-library'
```

For an unpacked archive such as `20261019-f-test-20261017/minio/manga-library/`, mount it and use it as the source instead of `src:manga-library`. That variant has not been run.

---

# History: MinIO mirror, AIStor later (2026-09-19)

**Status (2026-09-19): documented, not scheduled.** The stack runs on the user's own Docker Hub
mirror of the last community MinIO image. Moving to MinIO AIStor with a free license is worked out
below so it can be done in one PR when it matters; it is not urgent because the mirror works and
nothing in the stack uses a feature the mirror lacks.

## Where we are

- `minio/minio` was removed from Docker Hub (first seen failing 2026-09-11). `docker-compose.yml:140`
  and `docker-compose.dev.yml:48` run `purevert/minio:backup`, a public mirror under the project
  owner's Hub account, and `.github/workflows/ci-cargo.yml` starts the same image for the Rust
  integration tests (PR #151).
- The image is frozen. It gets no security fixes and no new releases. That is acceptable for a
  loopback-only service (`AUDIT-D5`: only the console on 127.0.0.1:9001 is published) but it is
  not a long-term answer.
- SeaweedFS was considered and deferred (2026-09-18): it would work, but it is a different S3
  implementation to re-validate the presign and multipart paths against, for no gain the mirror
  does not already give.

## What AIStor is, for this stack

`quay.io/minio/aistor/minio` is the maintained successor. Facts that matter here (from MinIO's
AIStor docs; re-check before doing the work, licensing terms move):

- **A license is required to start.** The free tier is a signed JWT issued per account; the file
  the owner already holds is `~/Downloads/minio.license`. It is a secret — it must never be
  committed, pasted into an issue, or printed in a log.
- The free license is **single node** with **no expiry** on the license itself, and may carry a
  **capacity cap**. Single node is exactly what this stack is; the cap is far above the ~0.5 GB
  in `data/minio` today. Check `mc license info` after the swap for the actual numbers.
- The license is passed as `--license /path/to/file` on the server command line (or
  `MINIO_LICENSE` with the file's contents). A mounted file is the right shape for this stack
  because every other credential is already a file under `secrets/`.
- Needs a server release of **RELEASE.2025-12-20 or newer**; the AIStor images are all newer.
- The S3 API, the console port, root user/password env and the `/data` layout are unchanged, so
  the existing `data/minio` volume is used in place. No bucket migration.

## The PR, when it happens

One PR on the working branch; CI keeps using the mirror (the runner has no license and needs
none — the tests only need an S3 endpoint).

1. Back up first: `tar -C data -czf ../minio-backup-$(date +%F).tgz minio` (≈544 MB as of
   2026-09-19). The data layout is meant to be forward-compatible, but treat the swap as a one-way
   door for the *image*: an older server may refuse a volume a much newer one has written to.
2. Put the license at `secrets/minio.license`, mode `0600`. `secrets/` is gitignored
   (`.gitignore:13`). For the dev compose file, `scripts/dev-box init` should copy it to
   `secrets/runtime/` like the other credentials (`docs/dev-box-setup.md:44`).
3. `docker-compose.yml` and `docker-compose.dev.yml`:
   ```yaml
   image: quay.io/minio/aistor/minio:RELEASE.<pinned>   # pin; never :latest
   command: server /data --console-address ":9001" --license /minio.license
   volumes:
     - ./data/minio:/data
     - ./secrets/minio.license:/minio.license:ro
   ```
   Keep `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD_FILE` as they are.
4. `docker compose up -d minio`, then verify:
   - `mc license info <alias>` (from the host with `mc` pointed at 127.0.0.1:9000, or inside the
     container if the image still ships `mc`) shows the plan, the node limit and any capacity
     figure — record them in this file.
   - a round trip through the app: upload a page, open it in the reader, export a ZIP. This covers
     presigned GET, PUT and the multipart path the export uses.
   - the backend's startup bucket check still passes (`backend-rust/src/minio.rs`).
5. Leave `ci-cargo.yml` on `purevert/minio:backup`. Note in the workflow why the two differ.
6. Update the `MinIO Docker Hub image gone` note in the maintainers' memory and this file's status
   line.

## Roll back

`docker compose down minio`, restore `data/minio` from the tarball, set the image back to the
mirror. Do not try to run the mirror over the AIStor-written volume.

## Not doing

- No `MINIO_LICENSE` env var with the JWT inline: it would land in `docker inspect` output and in
  any `compose config` dump.
- No license in CI. The tests do not need it and a secret in a fork's PR run is a leak path.
- No SeaweedFS in the same change; if the free tier's cap or single-node limit ever bites, that is
  the moment to revisit it, on its own PR.
