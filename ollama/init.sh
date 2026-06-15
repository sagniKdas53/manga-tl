#!/bin/sh

# Exit on any error
set -e

# Wait for Ollama server to start
echo "Waiting for Ollama server at $OLLAMA_HOST..."
until ollama list >/dev/null 2>&1; do
  sleep 2
done
echo "Ollama server is up!"

# Directory containing LM Studio models
MODELS_DIR="/lm-studio-models"

if [ ! -d "$MODELS_DIR" ]; then
  echo "Error: Models directory $MODELS_DIR not found!"
  exit 1
fi

echo "Scanning $MODELS_DIR for GGUF models..."

# Find all GGUF files in subdirectories, excluding multi-modal projections (mmproj)
find "$MODELS_DIR" -type f -name "*.gguf" | while read -r gguf_path; do
  # Skip mmproj vision models
  if echo "$gguf_path" | grep -q "mmproj"; then
    echo "Skipping mmproj file: $gguf_path"
    continue
  fi

  filename=$(basename "$gguf_path")
  # Strip quantization and extension suffix to get the model base name
  # e.g., gemma-4-E2B-it-Q4_K_M.gguf -> gemma-4-E2B-it
  # e.g., NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf -> NVIDIA-Nemotron-3-Nano-4B
  # e.g., gemma-4-12B-it-QAT-Q4_0.gguf -> gemma-4-12B-it-QAT
  model_base=$(echo "$filename" | sed -E 's/[-_](Q[0-9]_[K_A-Z0-9]+)\.gguf$//i' | sed 's/\.gguf$//i')
  
  # Normalize to lowercase for Ollama
  model_name=$(echo "$model_base" | tr '[:upper:]' '[:lower:]')

  echo "----------------------------------------"
  echo "Found GGUF: $filename"
  echo "Registering model in Ollama: $model_name"

  # Create Ollama model from GGUF path
  echo "FROM $gguf_path" > /tmp/Modelfile
  ollama create "$model_name" -f /tmp/Modelfile
  rm -f /tmp/Modelfile

  # Apply aliases based on the model name
  case "$model_name" in
    *gemma-3-4b-it*)
      echo "Setting aliases for Gemma 3 4B..."
      ollama cp "$model_name" "gemma3:4b"
      ollama cp "$model_name" "google/gemma-3-4b-it"
      ;;
    *gemma-4-e2b-it*)
      echo "Setting aliases for Gemma 4 E2B..."
      ollama cp "$model_name" "gemma4:e2b"
      ollama cp "$model_name" "google/gemma-4-e2b-it"
      ;;
    *gemma-4-e4b-it*)
      echo "Setting aliases for Gemma 4 E4B..."
      ollama cp "$model_name" "gemma4:e4b"
      ollama cp "$model_name" "google/gemma-4-e4b-it"
      ;;
    *gemma-4-12b-it-qat*|*gemma-4-12b-it*)
      echo "Setting aliases for Gemma 4 12B..."
      ollama cp "$model_name" "gemma4:12b"
      ollama cp "$model_name" "google/gemma-4-12b-it"
      ;;
    *nemotron-3-nano-4b*|*nvidia-nemotron-3-nano-4b*)
      echo "Setting aliases for Nemotron 3 Nano 4B..."
      ollama cp "$model_name" "nvidia/nemotron-3-nano-4b"
      ollama cp "$model_name" "nemotron:4b"
      ;;
  esac
done

echo "----------------------------------------"
echo "All models successfully registered!"
ollama list
