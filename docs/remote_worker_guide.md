# Remote Worker Setup and OCR Offloading Guide

This guide explains how to set up a dedicated **remote worker** (e.g., on a LAN machine with a GPU) and configure the system to offload computationally heavy **OCR** and **Panel Detection** tasks to it.

---

## 🏗️ How it Works

The Spring Boot backend on the main server acts as a coordinator, popping tasks from the Valkey/Redis queue and dispatching them downstream to the workers via HTTP POST.

Using the `WORKER_URLS` environment variable on the backend, you can specify multiple worker endpoints in priority order. When a task is popped, the backend attempts to submit it to each worker in order. By running a remote worker and configuring it to only accept specific queues (like OCR), you can distribute workload across machines:

```
                            ┌─────────────────────┐
                            │ Spring Boot Backend │
                            └──────────┬──────────┘
                                       │ Dispatcher
                  ┌────────────────────┴────────────────────┐
                  │ (queue:ocr)                             │ (queue:translation)
                  ▼                                         ▼
      ┌───────────────────────┐                 ┌───────────────────────┐
      │ Remote Worker (GPU)   │                 │ Local Worker (CPU)    │
      │ ALLOWED_QUEUES=ocr    │                 │ ALLOWED_QUEUES=all    │
      ├───────────────────────┤                 ├───────────────────────┤
      │ Accepts and runs OCR  │                 │ Skips/Falls back if   │
      │ tasks using GPU       │                 │ remote worker is free │
      └───────────────────────┘                 └───────────────────────┘
```

---

## 🌐 Network and Port Requirements

For a remote worker to communicate with the main server, ensure the following network ports are accessible:

| Service | Host | Port | Direction | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **Valkey/Redis** | Main Server | `6379` | Worker ➔ Main | Checking queue sizes and locking |
| **MinIO S3** | Main Server | `9000` | Worker ➔ Main | Downloading source images & uploading rendered layers |
| **Spring Boot** | Main Server | `8080` (or reverse proxy) | Worker ➔ Main | Job status callback updates |
| **Worker API** | Remote Worker | `8000` | Main ➔ Worker | Submitting jobs and checking health |

Ensure you open port `8000` in the remote worker's firewall to allow traffic from the main server.

---

## 🔒 Security and Authentication

Since the remote worker API is exposed over the network (e.g., LAN), you **must** configure request authentication to secure the endpoint.

1. **Shared Secret Key**: Both the Spring Boot backend and the remote worker must share the exact same secret key value.
   - On the main server, the backend loads this from the file specified in `WORKER_API_SECRET_FILE` (usually `./secrets/worker_api_secret.txt`).
   - On the remote worker, this is configured via the `WORKER_API_SECRET` environment variable in the `.env` file.
2. **Authorization Mechanism**:
   - The backend includes this secret in the `WORKER_API_SECRET` header of every outbound job submission and capabilities request.
   - The remote worker intercepts the header and verifies it. If it is missing or does not match, the worker returns `HTTP 401 Unauthorized`.

---

## 🛠️ Step 1: Set up the Remote Worker

### 1. Create Directory

On your remote machine, create a directory for the worker:

```bash
mkdir -p manga-worker/data
cd manga-worker
```

### 2. Configure Environment `.env`

Create a `.env` file in the `manga-worker` directory with the following variables. Replace `MAIN_SERVER_IP` with the IP address or hostname of your main server.

```ini
# Redis connection on main server
REDIS_HOST=MAIN_SERVER_IP
REDIS_PORT=6379

# MinIO storage on main server
MINIO_ENDPOINT=MAIN_SERVER_IP:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=your_minio_password_here

# Backend callback url on main server
BACKEND_CALLBACK_URL=http://MAIN_SERVER_IP:8080/tlhub/api/internal/jobs/callback
INTERNAL_API_TOKEN=your_internal_api_token_here
WORKER_API_SECRET=your_worker_api_secret_here

# Hardware configuration
PADDLEOCR_DEVICE=gpu   # Change to 'cpu' if no NVIDIA GPU is available
CONCURRENT_WORKERS=4

# Queue Filtering (Offload OCR and Panel Detection ONLY)
# Leave empty or omit if you want the worker to process all queues.
ALLOWED_QUEUES=queue:ocr,queue:panel-detection
```

### 3. Create Docker Compose Configuration

Create a `docker-compose.yml` file in the remote machine's `manga-worker` directory:

```yaml
services:
  worker:
    image: ghcr.io/sagnikdas53/manga-tl-worker:latest
    container_name: manga-remote-worker
    # Set to 'cpu' by default since we are running in CPU-only mode
    environment:
      - REDIS_HOST=${REDIS_HOST}
      - REDIS_PORT=${REDIS_PORT}
      - MINIO_ENDPOINT=${MINIO_ENDPOINT}
      - MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY}
      - MINIO_SECRET_KEY=${MINIO_SECRET_KEY}
      - BACKEND_CALLBACK_URL=${BACKEND_CALLBACK_URL}
      - INTERNAL_API_TOKEN=${INTERNAL_API_TOKEN}
      - WORKER_API_SECRET=${WORKER_API_SECRET}
      - PADDLEOCR_DEVICE=${PADDLEOCR_DEVICE}
      - CONCURRENT_WORKERS=${CONCURRENT_WORKERS}
      - ALLOWED_QUEUES=${ALLOWED_QUEUES}
    ports:
      - "8000:8000"
    volumes:
      - ./data/huggingface:/root/.cache/huggingface
      - ./data/paddlex:/root/.paddlex
    # Optional: Enable GPU access for PaddleOCR and Bubble Detection (requires nvidia-container-toolkit)
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: all
    #           capabilities: [gpu]
    restart: unless-stopped
```

### 4. Verify Connectivity (Optional but Recommended)

Before starting the worker container, you can verify that the remote worker machine is capable of successfully reaching all required services on the main server.

If python is installed locally on the remote machine, you can run the test script:

```bash
# Set your environment variables (or let it read from .env)
export REDIS_HOST=MAIN_SERVER_IP
export MINIO_ENDPOINT=MAIN_SERVER_IP:9000
export BACKEND_CALLBACK_URL=http://MAIN_SERVER_IP:8080/tlhub/api/internal/jobs/callback

python run_connection_test.py
```

Alternatively, you can run the check inside a temporary docker container using your configured `.env` file:

```bash
docker run --rm --env-file .env --entrypoint python ghcr.io/sagnikdas53/manga-tl-worker:latest run_connection_test.py
```

---

### 5. Start the Remote Worker

Run the container:

```bash
docker compose up -d
```

Check the logs to ensure the worker starts correctly and seeds the models:

```bash
docker compose logs -f
```

---

## 🔗 Step 2: Configure Backend on Main Server

On the main server, you need to update the configuration to route tasks to the remote worker.

1. Open the root `.env` file on the main server.
2. Modify or add the `WORKER_URLS` variable to include the remote worker.
   - List the remote worker **first** to give it higher priority:

   ```ini
   WORKER_URLS=http://REMOTE_WORKER_IP:8000,http://worker:8000
   ```

3. Recreate the backend container to apply the environment changes:

   ```bash
   docker compose up -d --force-recreate backend
   ```

---

## 🔄 Queue Routing Behavior

With `ALLOWED_QUEUES=queue:ocr,queue:panel-detection` set on the remote worker:

1. **OCR Task (`queue:ocr`)**:
   - Backend pops an OCR job and sends it to the remote worker.
   - The remote worker accepts the job (HTTP 202) and executes it on the GPU.

2. **Translation Task (`queue:translation`)**:
   - Backend pops a translation job and tries the remote worker first.
   - The remote worker rejects the job with `HTTP 429` (since it is not in its allowed list).
   - Backend dispatcher receives the 429 and immediately tries the next worker (`http://worker:8000` - local worker), which accepts and runs it.
