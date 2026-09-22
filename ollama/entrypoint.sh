#!/bin/sh

set -e

echo "Starting Ollama..."

ollama serve &
OLLAMA_PID=$!

echo "Waiting for Ollama to start..."

until ollama list >/dev/null 2>&1; do
    sleep 2
done

echo "Ollama is ready."
echo "Pulling base model: ${BASE_MODEL}"

ollama pull "${BASE_MODEL}"

echo "Model ${BASE_MODEL} is ready."

wait $OLLAMA_PID
