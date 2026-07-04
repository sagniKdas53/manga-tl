# Decoupled Ollama & Model Configuration Guide

This directory contains a separate Docker Compose configuration for running **Ollama** independently of the main Manga Library stack. This allows you to host Ollama on a different machine (e.g., a dedicated GPU server) or run it locally without starting the entire application.

---

## 1. Running Ollama on the Current Machine (Decoupled)

To start the Ollama stack on this machine using your existing local LM Studio models:

```bash
cd ollama
docker compose up -d
```

### Worker Connection

Since the worker is in a different Docker Compose stack (and network), it communicates with Ollama via the host gateway. In the root `.env` file, ensure:

```properties
LOCAL_LLM_ENDPOINT=http://host.docker.internal:11434/v1/chat/completions
```

---

## 2. Running Ollama on a Different (Remote) Machine

If you want to offload the LLM workload to another machine with a GPU:

### Option A: Running natively on the remote host (Recommended)

1. Install Ollama:

   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ```

2. By default, Ollama only listens on `127.0.0.1`. You **must** configure it to listen on all interfaces so the worker can connect:
   - Edit the systemd service:

     ```bash
     sudo systemctl edit ollama.service
     ```

   - Add the following lines in the editor:

     ```ini
     [Service]
     Environment="OLLAMA_HOST=0.0.0.0"
     ```

   - Reload and restart:

     ```bash
     sudo systemctl daemon-reload
     sudo systemctl restart ollama
     ```

### Option B: Running via Docker on the remote host

Run Ollama with GPU acceleration and expose port `11434`:

```bash
docker run -d --gpus=all \
  -v ollama:/root/.ollama \
  -p 11434:11434 \
  --name ollama \
  ollama/ollama
```

---

## 3. How to Download/Register Models on the Remote Machine

Since the remote machine won't have direct access to your local LM Studio directory, you have two choices for models:

### Method A: Pulling from the Official Ollama Registry (Easiest)

You can pull standard models directly from [Ollama's Model Library](https://ollama.com/library):

- **Native:**

  ```bash
  ollama pull gemma2:9b
  ```

- **Docker:**

  ```bash
  docker exec -it ollama ollama pull gemma2:9b
  ```

### Method B: Uploading and Registering a Custom GGUF (e.g. Gemma 4 4.6B)

If you want to run the exact same Gemma 4 model:

1. Copy the `.gguf` file (e.g., `gemma-4-E4B-it-Q4_K_M.gguf`) from your machine to the remote machine using `scp` or `rsync`.
2. Create a file named `Modelfile` on the remote machine:

   ```dockerfile
   FROM /path/to/gemma-4-E4B-it-Q4_K_M.gguf
   ```

3. Register the model under the desired name:
   - **Native:**

     ```bash
     ollama create gemma4:e4b -f Modelfile
     ```

   - **Docker:** (Make sure the `.gguf` file and `Modelfile` are mounted or copied into the container)

     ```bash
     docker exec -it ollama ollama create gemma4:e4b -f /path/to/Modelfile
     ```

---

## 4. Connecting the Worker to the Remote Machine

Once Ollama is running on the remote machine and the model is registered, configure the root `.env` of your Manga Library stack to point to it:

1. Open `.env`.
2. Change the local LLM endpoint and model settings:

   ```properties
   DISABLE_LOCAL_LLM=false
   LOCAL_LLM_PROVIDER=ollama
   LOCAL_LLM_ENDPOINT=http://<REMOTE_MACHINE_IP_ADDRESS>:11434/v1/chat/completions
   LOCAL_LLM_MODEL=gemma4:e4b     # Or whichever model you registered/pulled
   ```

3. Make sure port `11434` on the remote machine is open in the firewall to allow traffic from the Manga Library worker's IP address.
